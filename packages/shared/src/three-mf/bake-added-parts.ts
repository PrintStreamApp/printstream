/**
 * Added part volumes for the shared 3MF bake.
 * Hosts with an inline mesh are wrapped into components before their new
 * volume is appended, preserving BambuStudio's mesh-or-components invariant.
 */
import type { SceneEdit } from '../slicing.js'
import { isProcessSettingKey } from '../process-settings.js'
import { threeMfPartSubtypeCarriesFilament } from '../three-mf-part-subtype.js'
import { serializeTextInfo, type TextInfo } from './text-info.js'
import {
  serializeBambuStudioShape,
  serializeSvgPartRecord,
  type BambuStudioShape,
  type SvgPartRecord
} from './svg-shape.js'
import { escapeXmlAttribute } from './xml-write.js'
import { formatThreeMfTransformValue, IDENTITY_THREE_MF_TRANSFORM, productionUuidAttr } from './bake-xml-format.js'
import { injectModelSettingsObjects, injectResourcesObjects } from './bake-xml-inject.js'

/**
 * Bake the edit's added part volumes (normal parts, negative parts, modifiers, support
 * blockers/enforcers) into the documents: each part's already-injected mesh object is
 * referenced as a `<component>` of its host root object (object-local transform),
 * and the host's `model_settings.config` entry gains a `<part>` with the Bambu
 * subtype. Hosts that carry their mesh inline (imports saved by an earlier session,
 * generic 3MFs) are first wrapped: the mesh moves to a new object referenced by an
 * identity component, and the host's existing settings `<part>` is re-keyed to that
 * new id so 3MF's object = mesh XOR components rule holds.
 *
 * Must run AFTER the edit's imports are injected: an added part's host may itself be a staged
 * import (a part added to a model the user has not saved yet), which is only resolvable through
 * `importIdToObjectId`. The inline-mesh wrapping branch below is the normal path for such a host,
 * since a freshly baked import always carries its mesh inline.
 */
/**
 * Exported for `bake-documents.addedParts.test.ts`: the `<part>` rewrites here are regex work over
 * XML whose exact shape varies between writers, which is a unit test's job rather than a full
 * archive round trip's.
 */
export function applyAddedParts(
  modelXml: string,
  modelSettingsXml: string,
  addedParts: NonNullable<SceneEdit['addedParts']>,
  importIdToObjectId: ReadonlyMap<string, number>,
  allocateObjectId: () => number,
  genUuid: (() => string) | null,
  filamentToExtruder: ReadonlyMap<number, number>,
  /**
   * Hosts that keep NO geometry of their own: their added parts ARE the object.
   *
   * Resolved to baked object ids by the caller, because an entry may name an import that only gets
   * an id here. See {@link sceneEditRemovedObjectBodySchema} for why this cannot be a removal.
   */
  removedBodies: ReadonlySet<number> = new Set()
): { modelXml: string; modelSettingsXml: string } {
  for (const part of addedParts) {
    const partObjectId = importIdToObjectId.get(part.meshImportId)
    if (partObjectId == null) {
      throw new Error('Scene edit adds a part from an unknown imported mesh')
    }
    const hostObjectId = part.objectId ?? (part.importId != null ? importIdToObjectId.get(part.importId) : undefined)
    if (hostObjectId == null) {
      throw new Error('Scene edit adds a part to an unknown host model')
    }
    const parentPattern = new RegExp(`(<object\\b[^>]*\\bid="${hostObjectId}"(?:[^>]*)>)([\\s\\S]*?)(</object>)`)
    const parentMatch = modelXml.match(parentPattern)
    if (!parentMatch) {
      throw new Error(`Scene edit adds a part to a missing object ${hostObjectId}`)
    }
    const transform = part.matrix.map(formatThreeMfTransformValue).join(' ')
    const componentXml = `    <component objectid="${partObjectId}"${productionUuidAttr(genUuid)} transform="${transform}"/>`
    const body = parentMatch[2]!
    if (/<components\b/.test(body)) {
      const nextBody = body.replace(/<\/components>/, `${componentXml}\n   </components>`)
      modelXml = modelXml.replace(parentPattern, (_match, open: string, _body: string, close: string) => `${open}${nextBody}${close}`)
    } else if (/<mesh\b/.test(body)) {
      // Inline-mesh parent: move the mesh into its own object and reference both.
      const meshObjectId = allocateObjectId()
      const meshMatch = body.match(/<mesh\b[\s\S]*?<\/mesh>/)
      if (!meshMatch) throw new Error(`Object ${part.objectId} has an unreadable mesh`)
      const meshObjectXml = [
        `  <object id="${meshObjectId}"${productionUuidAttr(genUuid)} type="model">`,
        `   ${meshMatch[0]}`,
        '  </object>'
      ].join('\n')
      // The object's OWN geometry becomes component 0 -- UNLESS the user deleted it, in which case
      // it is simply never referenced and the added parts are the whole component list. Dropping it
      // here rather than removing it afterwards is what lets the surviving parts keep their own
      // names: a promoted body is named after the OBJECT, so a delete that went through a promotion
      // renamed the survivor and made the same edit read differently before and after a save.
      const keepsBody = !removedBodies.has(hostObjectId)
      const nextBody = body.replace(/<mesh\b[\s\S]*?<\/mesh>/, [
        '<components>',
        ...(keepsBody
          ? [`    <component objectid="${meshObjectId}"${productionUuidAttr(genUuid)} transform="${IDENTITY_THREE_MF_TRANSFORM}"/>`]
          : []),
        componentXml,
        '   </components>'
      ].join('\n'))
      modelXml = modelXml.replace(parentPattern, (_match, open: string, _body: string, close: string) => `${open}${nextBody}${close}`)
      // The moved mesh is only worth keeping as an object while something references it; the
      // unreferenced-object sweep would take it anyway, but not writing it keeps the file honest.
      if (keepsBody) modelXml = injectResourcesObjects(modelXml, meshObjectXml)
      // The parent's existing settings <part> keyed by the parent id now describes the
      // moved mesh component -- or, where the body is gone, describes nothing and is dropped, so
      // the object's part list is exactly its added parts.
      modelSettingsXml = keepsBody
        ? modelSettingsXml.replace(
          new RegExp(`(<object\\b[^>]*\\bid="${hostObjectId}"[^>]*>[\\s\\S]*?)<part id="${hostObjectId}"`),
          `$1<part id="${meshObjectId}"`
        )
        // A `<part>` may be SELF-CLOSING: nothing in the format forbids `<part id="1" .../>`, and
        // only our own writers always emit a closing tag. Matching `...>[\s\S]*?</part>` on one
        // then ran past it to the NEXT part's closing tag and deleted that part's name, extruder
        // and settings with it. The alternation takes the self-closing form first, so the greedy
        // form is only reached for an entry that genuinely has a body.
        : modelSettingsXml.replace(
          new RegExp(`(<object\\b[^>]*\\bid="${hostObjectId}"[^>]*>[\\s\\S]*?)`
            + `<part id="${hostObjectId}"(?:[^>]*\\/>|[^>]*>[\\s\\S]*?<\\/part>)\\s*`),
          '$1'
        )
    } else {
      throw new Error(`Object ${hostObjectId} has neither mesh nor components`)
    }
    // Only a filament-carrying subtype gets an extruder; see threeMfPartSubtypeCarriesFilament.
    const extruder = part.filamentId != null && threeMfPartSubtypeCarriesFilament(part.subtype)
      ? filamentToExtruder.get(part.filamentId) ?? part.filamentId
      : undefined
    modelSettingsXml = addModelSettingsPartEntry(
      modelSettingsXml, hostObjectId, partObjectId, part.subtype, part.name, part.settings, extruder,
      { ...(part.textInfo ? { textInfo: part.textInfo } : {}),
        ...(part.svgPart ? { svgPart: part.svgPart } : {}),
        ...(part.bambuShape ? { bambuShape: part.bambuShape } : {}) }
    )
  }
  return { modelXml, modelSettingsXml }
}

/**
 * The per-volume records that say what a part was MADE FROM, so it reopens editable rather than as
 * anonymous solids. Grouped rather than passed one-by-one because there are now three of them and
 * they all answer the same question about the same `<part>`.
 *
 * A part carries AT MOST ONE authoring record: `textInfo` for the text tool, `svgPart` for the SVG
 * tool. `bambuShape` is not a third author: it is BambuStudio's interop view of the same SVG part,
 * and rides alongside `svgPart` only when the import produced ONE part (see `svg-shape.ts`).
 */
interface ModelSettingsPartSidecars {
  textInfo?: TextInfo
  svgPart?: SvgPartRecord
  bambuShape?: BambuStudioShape
}

/**
 * Append a `<part>` (with subtype + name, plus any per-volume config metadata: how
 * BambuStudio persists modifier-volume overrides) to a parent's model_settings entry.
 */
function addModelSettingsPartEntry(
  modelSettingsXml: string,
  parentObjectId: number,
  partObjectId: number,
  subtype: string,
  name: string,
  settings?: Record<string, string>,
  extruder?: number,
  sidecars?: ModelSettingsPartSidecars
): string {
  // Process-setting keys only: the name/extruder/matrix entries are authored explicitly, so a
  // structural key smuggled through the settings map must not duplicate or clobber them.
  const settingsXml = Object.entries(settings ?? {}).filter(([key]) => isProcessSettingKey(key)).map(([key, value]) =>
    `      <metadata key="${escapeXmlAttribute(key)}" value="${escapeXmlAttribute(value)}"/>`)
  const partXml = [
    `    <part id="${partObjectId}" subtype="${escapeXmlAttribute(subtype)}">`,
    `      <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...(extruder != null ? [`      <metadata key="extruder" value="${extruder}"/>`] : []),
    ...settingsXml,
    // Each authoring record lives inside the <part> and is keyed to the VOLUME, which is why these
    // are authored here rather than alongside the object's own metadata. Studio's own writer emits
    // <BambuStudioShape> before <text_info> (bbs_3mf.cpp:8295 then :8299); ours goes last because
    // Studio does not know it and an unrecognised element is simply skipped there.
    ...(sidecars?.bambuShape ? [`      ${serializeBambuStudioShape(sidecars.bambuShape)}`] : []),
    // A text part records what it was typed from, so a typo is a re-edit rather than a rebuild.
    ...(sidecars?.textInfo ? [`      ${serializeTextInfo(sidecars.textInfo)}`] : []),
    // An SVG part records the artwork and which shape of it this part is, for the same reason.
    ...(sidecars?.svgPart ? [`      ${serializeSvgPartRecord(sidecars.svgPart)}`] : []),
    '    </part>'
  ].join('\n')
  const objectPattern = new RegExp(`(<object\\b[^>]*\\bid="${parentObjectId}"[^>]*>)([\\s\\S]*?)(</object>)`)
  if (objectPattern.test(modelSettingsXml)) {
    return modelSettingsXml.replace(objectPattern, (_match, open: string, body: string, close: string) =>
      `${open}${body.trimEnd()}\n${partXml}\n  ${close}`)
  }
  // Parent had no settings entry (minimal/generic file): create one.
  const objectXml = [`  <object id="${parentObjectId}">`, partXml, '  </object>'].join('\n')
  return injectModelSettingsObjects(modelSettingsXml, objectXml)
}
