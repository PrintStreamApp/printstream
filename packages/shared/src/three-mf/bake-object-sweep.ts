/**
 * Validate placed 3MF object references and sweep resources left unplaced by
 * the edited build. Component targets survive the sweep because a placed
 * assembly can still depend on their meshes.
 */
import { assertAcyclicComponentGraph } from './component-graph.js'
import { ensureApplicationMarker } from './application-marker.js'
import type { ArrangedInstance } from './bake-arranged-model-settings.js'

/**
 * Refuse to place an object the model does not contain.
 *
 * Throws rather than dropping the instance: a placement naming a missing object means the caller and
 * the base project disagree about what exists (a stale editor session against a concurrently-saved
 * file is the realistic route), and silently saving the subset would persist that disagreement as
 * deleted models. Named ids are listed so the failure says which.
 */
function assertPlacedObjectsExist(modelXml: string, arranged: ReadonlyArray<{ objectId: number }>): void {
  const present = new Set<number>()
  for (const match of modelXml.matchAll(/<object\b[^>]*?\bid="(\d+)"/g)) {
    present.add(Number.parseInt(match[1]!, 10))
  }
  const missing = [...new Set(arranged.map((instance) => instance.objectId))].filter((id) => !present.has(id))
  if (missing.length > 0) {
    throw new Error(`Scene edit places object${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which this project does not contain`)
  }
}

/**
 * Strip resources and settings entries for objects no longer placed by the edited build.
 * BambuStudio deletes unplaced resources on load, so keeping them in our file would leave
 * misleading archive contents and dangling settings. Component targets are conservatively
 * kept because a placed assembly may still need their meshes.
 */
export function removeUnreferencedObjects(
  modelXml: string,
  modelSettingsXml: string,
  buildObjectIds: ReadonlySet<number>
): { modelXml: string; modelSettingsXml: string } {
  const referenced = new Set(buildObjectIds)
  for (const match of modelXml.matchAll(/<component\b[^>]*\bobjectid="(\d+)"/gi)) {
    referenced.add(Number.parseInt(match[1]!, 10))
  }
  const dropUnreferencedObjects = (xml: string) =>
    xml.replace(/[ \t]*<object\b[^>]*\bid="(\d+)"[^>]*>[\s\S]*?<\/object>\n?/g, (block, id: string) =>
      referenced.has(Number.parseInt(id, 10)) ? block : ''
    )
  // Assemble entries pointing at removed objects would dangle; drop those too.
  const settingsXml = dropUnreferencedObjects(modelSettingsXml)
    .replace(/[ \t]*<assemble_item\b[^>]*\bobject_id="(\d+)"[^>]*\/>\n?/g, (block, id: string) =>
      referenced.has(Number.parseInt(id, 10)) ? block : ''
    )
  return { modelXml: dropUnreferencedObjects(modelXml), modelSettingsXml: settingsXml }
}

/**
 * Validate placed ids, remove unreferenced resources, reject component cycles,
 * and stamp the application marker before later part edits run.
 */
export function validateAndSweepPlacedObjects(
  modelXml: string,
  modelSettingsXml: string,
  arranged: readonly ArrangedInstance[]
): { modelXml: string; modelSettingsXml: string } {
  // Every placed object must EXIST before the sweep below runs, because the sweep is seeded from the
  // build items: an id naming nothing keeps the whole model from being referenced, so the real
  // objects are stripped as unused and the file is left with one item pointing at nothing. That is
  // silent geometry loss on our side and a refused open on BambuStudio's (`bbs_3mf.cpp:4205-4210`
  // aborts the parse rather than skipping the item). Checked here rather than at the schema, which
  // is context-free and cannot know which ids the base project holds.
  assertPlacedObjectsExist(modelXml, arranged)

  const cleaned = removeUnreferencedObjects(modelXml, modelSettingsXml, new Set(arranged.map((instance) => instance.objectId)))
  // The components are only complete once the imports, clones and added parts are all in. A cycle
  // among them hangs the importer outright rather than failing, so it must never reach a file.
  assertAcyclicComponentGraph(cleaned.modelXml)
  // We author Bambu-shaped documents whatever the base was, so the file has to SAY so: without the
  // generator marker the importer forces `dont_load_config` and skips the whole config half of the
  // archive (`bbs_3mf.cpp:1905-1908`), opening the project as bare geometry with every setting gone.
  // Only the from-scratch scaffold used to write it, so a save over any base that lacked one
  // inherited the defect and could never recover from it.
  cleaned.modelXml = ensureApplicationMarker(cleaned.modelXml)
  modelXml = cleaned.modelXml
  modelSettingsXml = cleaned.modelSettingsXml

  return { modelXml, modelSettingsXml }
}
