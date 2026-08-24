/**
 * The bake, one step up from the document transforms: what to read, and what to write.
 *
 * {@link planEditedThreeMf} turns a `SceneEdit` plus the source entries into a PLAN -- either a set
 * of entry transforms to apply while copying the base archive, or the complete entry list for a
 * project built from scratch. It performs no I/O, so the api can apply the plan with yauzl/yazl
 * over a path on disk and the browser can apply it with fflate over bytes the user picked, without
 * either side reimplementing the 195 lines of decisions in here.
 *
 * {@link readThreeMfBakeSource} owns the other half of that contract: WHICH entries a bake needs and
 * how big each is allowed to be. Callers supply only a reader, so the size caps and the
 * absent-entry fallbacks cannot drift between surfaces.
 *
 * Transforms are FUNCTIONS, not precomputed strings, on purpose: a project's `/3D/Objects/*.model`
 * mesh bodies are the bulk of the file, and they are rewritten as they stream past. Materialising
 * them all to save one file would turn a large assembly into an out-of-memory failure.
 */
import type { SceneEdit, SceneEditObjectBrimEars } from '../slicing.js'
import type { ThreeMfSettingsRepairReason } from '../printer-contracts.js'
import { collectSettingsRepairReasons } from '../repairs/index.js'
import {
  NEW_PROJECT_MODEL_SETTINGS_XML,
  NEW_PROJECT_MODEL_XML,
  THREE_MF_CONTENT_TYPES_XML,
  THREE_MF_RELS_XML,
  appendImportPartRelationships,
  applyGlobalProcessOverrides,
  applyModelKindMarker,
  allSubModelPaths,
  applyTrianglePaintToModelEntry,
  buildEditedThreeMfDocuments,
  buildProjectSettingsTransforms,
  filamentSlotIdRemap,
  isIdentityFilamentSlotRemap,
  mergeCustomGcodePerLayer,
  remapCustomGcodeFilamentIds,
  resolvePartPaintByEntry,
  resolveRepairMeshesByEntry,
  rewriteSliceInfoNozzleGroups,
  serializeBrimEarPoints,
  subModelPathsForObjects,
  type ImportedObjectInput,
  type TrianglePaintAttribute
} from './bake-documents.js'
import { remapColorPaintInModelXml } from './triangle-paint-codec.js'
import {
  THREE_MF_MODEL_ENTRY,
  THREE_MF_MODEL_RELS_ENTRY,
  THREE_MF_MODEL_SETTINGS_ENTRY,
  THREE_MF_PROJECT_SETTINGS_ENTRY,
  THREE_MF_SLICE_INFO_ENTRY as SLICE_INFO_ENTRY
} from './entries.js'
import { isEmbeddedFilamentPresetEntry } from './embedded-presets.js'
import { CUSTOM_GCODE_PER_LAYER_ENTRY, sliceRecordFilamentIds, stringArray } from './index-parser.js'
import { repairObjectMeshesInModelEntry } from './mesh-repair.js'
import { applyObjectProcessOverridesXml, objectHeadOf, readObjectProcessOverridesFromHead, rekeyObjectProcessOverrides, type ObjectProcessOverrides } from './object-overrides.js'
import { BRIM_EAR_POINTS_ENTRY, parseRootModelObjectIdOrder } from './scene-parser.js'
import { OBJECT_ORDINAL_SIDECAR_ENTRIES, remapObjectOrdinalSidecar } from './object-ordinal-sidecars.js'
import { remapSliceInfoPlates, sourcePlateMapping } from './plate-metadata.js'

/** Outcome of a bake the slicer needs afterwards. */
export interface ThreeMfBakeResult {
  /**
   * For each object replaced via "Replace with…" (`edit.meshReplacements`), the baked `object_id`
   * its staged-import geometry was written as, so the slicer can carry the original object's
   * per-object PROCESS overrides onto the replacement.
   */
  replacedObjectIds: Array<{ originalObjectId: number; bakedObjectId: number }>
  /** For each staged import baked in, the `object_id` its geometry was written as. */
  importObjectIds: Array<{ importId: string; objectId: number }>
  /**
   * For each INDEPENDENT object copy, the placeholder id it was addressed by and the real
   * `object_id` it baked as. Overrides ride the save/slice REQUEST keyed by the placeholder, so
   * they must be re-keyed through this.
   */
  clonedObjectIds: Array<{ originalObjectId: number; bakedObjectId: number }>
}

/** The source entries a bake reads, already decoded to text. */
export interface ThreeMfBakeSource {
  modelXml: string
  modelSettingsXml: string
  projectSettingsJson: string | null
  customGcodeXml: string | null
  /** Record of a previous slice; null for an unsliced project. */
  sliceInfoXml: string | null
  /** Sub-model relationships (Production-Extension projects); null when the source has none. */
  modelRelsXml: string | null
  /** `/3D/Objects/*.model` bodies, needed only to copy an object independently. */
  subModelEntries: ReadonlyMap<string, string>
  /**
   * False when building from scratch. The caller then writes {@link ThreeMfBakePlan.freshEntries}
   * as a whole new archive instead of copying a base.
   */
  hasBase: boolean
}

/**
 * What to write. Exactly one of `copy` / `freshEntries` is set: `copy` when there is a base archive
 * to stream through, `freshEntries` when the project is built from nothing.
 */
export interface ThreeMfBakePlan {
  result: ThreeMfBakeResult
  copy: {
    /** Entry name → rewrite, or `null` from the transform to DROP that entry from the output. */
    transforms: Map<string, (xml: string) => string | null>
    /** Entries to add that the source did not already contain. */
    appendEntries: Array<{ name: string; content: string }>
  } | null
  freshEntries: Array<{ name: string; content: string }> | null
  /**
   * The repairable defects present in the documents this bake WROTE, a save-time counterpart to
   * the same check every surface runs on a file at rest ({@link collectSettingsRepairReasons}).
   *
   * PURE and non-blocking by design, mirroring BambuStudio's split between a normalise pass that
   * mutates and a `validate()` that only reports: what to do about a reason is the caller's
   * decision, not this module's, because the right answer differs per surface (a save logs and
   * proceeds; a CLI could refuse). Nothing here rewrites the output, a bake that heals itself
   * silently is how these defects stayed invisible in the first place.
   *
   * Call AFTER the plan has been written: the project-settings transform runs lazily during the
   * write, so before that this reports on an unwritten document and returns nothing useful.
   */
  settingsRepairReasons: () => ThreeMfSettingsRepairReason[]
}

export interface ThreeMfBakeOptions {
  /** Extra archive entries written verbatim; on a base build these replace a same-named source entry. */
  extraEntries?: Array<{ name: string; content: string }>
  /** Project-wide process-setting overrides merged into `project_settings.config`. */
  globalProcessOverrides?: Record<string, string | string[]>
  /** Stamp the output as a single-object model export (`printstream_model_kind`). */
  objectExportMarker?: boolean
  /**
   * Per-object PROCESS overrides to write into `model_settings.config`, keyed by baked `object_id`.
   *
   * These ride the save REQUEST rather than the `SceneEdit`, so a caller that has them must pass
   * them here or they are lost. The api instead applies them in its own later pass while preparing
   * a slice; a caller that bakes once (the browser) supplies them and gets them in that one pass.
   */
  objectProcessOverrides?: ObjectProcessOverrides
}

/** Reads one entry as UTF-8 text, or resolves null when it is absent or over `maxBytes`. */
export type ThreeMfEntryTextReader = (entryPath: string, maxBytes: number) => Promise<string | null>

const MODEL_ENTRY_MAX_BYTES = 256 * 1024 * 1024
const RELS_MAX_BYTES = 4 * 1024 * 1024
const SETTINGS_MAX_BYTES = 8 * 1024 * 1024

/**
 * Read everything a bake needs through `read`, applying the same caps and absent-entry fallbacks on
 * every surface. Sub-models are fetched only when the edit copies an object independently, since a
 * copy needs its own mesh entry (sharing the source's would make painting the copy repaint its
 * source).
 */
export async function readThreeMfBakeSource(read: ThreeMfEntryTextReader, edit: SceneEdit): Promise<ThreeMfBakeSource> {
  // The root model is the one entry with no sane fallback: defaulting it to the new-project
  // scaffold would silently replace the user's geometry with an empty plate on a damaged archive.
  const modelXml = await read(THREE_MF_MODEL_ENTRY, MODEL_ENTRY_MAX_BYTES)
  if (modelXml == null) throw new Error(`3MF is missing its root model entry (${THREE_MF_MODEL_ENTRY})`)
  const subModelEntries = new Map<string, string>()
  if ((edit.objectClones?.length ?? 0) > 0) {
    const clonedSourceIds = new Set((edit.objectClones ?? []).map((clone) => clone.sourceObjectId))
    for (const entryPath of subModelPathsForObjects(modelXml, clonedSourceIds)) {
      const body = await read(entryPath, MODEL_ENTRY_MAX_BYTES)
      if (body) subModelEntries.set(entryPath, body)
    }
  }
  return {
    modelXml,
    modelSettingsXml: (await read(THREE_MF_MODEL_SETTINGS_ENTRY, SETTINGS_MAX_BYTES)) ?? NEW_PROJECT_MODEL_SETTINGS_XML,
    projectSettingsJson: await read(THREE_MF_PROJECT_SETTINGS_ENTRY, SETTINGS_MAX_BYTES),
    customGcodeXml: await read(CUSTOM_GCODE_PER_LAYER_ENTRY, RELS_MAX_BYTES),
    sliceInfoXml: await read(SLICE_INFO_ENTRY, SETTINGS_MAX_BYTES),
    modelRelsXml: await read(THREE_MF_MODEL_RELS_ENTRY, RELS_MAX_BYTES),
    subModelEntries,
    hasBase: true
  }
}

/** The source for a project built from nothing (the new-project scaffold). */
export function emptyThreeMfBakeSource(): ThreeMfBakeSource {
  return {
    modelXml: NEW_PROJECT_MODEL_XML,
    modelSettingsXml: NEW_PROJECT_MODEL_SETTINGS_XML,
    projectSettingsJson: null,
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: new Map(),
    hasBase: false
  }
}

/**
 * Decide every rewrite a `SceneEdit` implies. Pure: the caller performs the I/O described by the
 * returned {@link ThreeMfBakePlan}.
 */
/**
 * Whether a synthesized project-settings document is worth writing at all.
 *
 * BambuStudio sizes the filament count off `filament_colour` and THROWS when it is absent or empty
 * ("Invalid configuration file", `PresetBundle.cpp:3723-3727`) on the ordinary project-open path
 * (`Plater.cpp:8449`). So a document synthesized for some OTHER reason (a plate type, a global
 * override, the export marker) against an edit carrying no filament list makes the project
 * unopenable.
 *
 * SKIPPING beats refusing, and refusing was tried. A project with no settings entry at all is fine,
 * and the bake proves it one branch over by writing none when no transform applies; a base whose own
 * settings already name no filament is likewise written unasserted. Throwing turned "would have
 * written a plate type and nothing else" into a failed save for a file class this bake itself
 * emits, when omitting a document nobody can use was already the better answer sitting next to it.
 */
function settingsDocumentNamesFilaments(json: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return true
  }
  if (!parsed || typeof parsed !== 'object') return true
  const record = parsed as Record<string, unknown>
  // An empty document carries nothing to lose and makes no filament claim to contradict.
  if (Object.keys(record).length === 0) return true
  return Array.isArray(record.filament_colour) && record.filament_colour.length > 0
}

/** The from-scratch settings entry, or null when it would name no filament and must be skipped. */
function freshProjectSettings(applyProjectSettings: (json: string) => string): string | null {
  const json = applyProjectSettings('{}')
  return settingsDocumentNamesFilaments(json) ? json : null
}

export function planEditedThreeMf(
  source: ThreeMfBakeSource,
  edit: SceneEdit,
  imports: ImportedObjectInput[] = [],
  options: ThreeMfBakeOptions = {}
): ThreeMfBakePlan {
  const {
    modelXml: baseModelXml,
    modelSettingsXml: baseModelSettingsXml,
    projectSettingsJson,
    customGcodeXml: baseCustomGcodeXml,
    sliceInfoXml: baseSliceInfoXml,
    modelRelsXml: baseModelRelsXml,
    subModelEntries
  } = source

  const documents = buildEditedThreeMfDocuments(
    baseModelXml,
    baseModelSettingsXml,
    projectSettingsJson,
    edit,
    imports,
    subModelEntries
  )
  let modelXml = documents.modelXml
  const modelSettingsXml = documents.modelSettingsXml

  // Map each replaced object to the baked object_id its import landed on, so the slicer can
  // re-key the original object's per-object process overrides onto the replacement.
  const replacedObjectIds = (edit.meshReplacements ?? []).flatMap((replacement) => {
    const bakedObjectId = documents.importIdToObjectId.get(replacement.importId)
    return bakedObjectId != null ? [{ originalObjectId: replacement.objectId, bakedObjectId }] : []
  })
  const importObjectIds = imports.flatMap((imported) => {
    const objectId = documents.importIdToObjectId.get(imported.importId)
    return objectId != null ? [{ importId: imported.importId, objectId }] : []
  })
  const result: ThreeMfBakeResult = { replacedObjectIds, importObjectIds, clonedObjectIds: documents.clonedObjectIds }

  // Per-object overrides arrive keyed by the identity the REQUEST used, which for a replaced object
  // or an independent copy is not the id this bake wrote. Re-key them here, where that map is
  // known, rather than leaving it to each caller: the API did it in a later pass and the browser's
  // local save did not, so saving to disk silently dropped the settings on any replaced or copied
  // object. Callers that still re-key afterwards are unaffected, this is idempotent.
  const requestObjectProcessOverrides = options.objectProcessOverrides
    ? rekeyObjectProcessOverrides(options.objectProcessOverrides, [...replacedObjectIds, ...documents.clonedObjectIds])
    : undefined

  // "Replace with…" keeps the object's IDENTITY, so it must keep the object's per-object PROCESS
  // overrides, and NOTHING ELSE CARRIES THEM: the source object's block is gone from the baked
  // document and the replacement is a freshly rendered object with a head of its own. Seed them
  // from the source here so that invariant belongs to the BAKE.
  //
  // Re-keying the request alone was not enough, and the gap was invisible because the two callers
  // differ. A SAVE sends the whole override set unconditionally, so a saved file kept the settings
  // and every surface went on showing them. A SLICE sends only what the user CHANGED against the
  // file, so an override nobody touched was absent from the request, the re-key had nothing to
  // move, and the file handed to the engine lost it. Reported as: an object with `enable_support`
  // on, under a preset with supports off, stopped generating support the moment its mesh was
  // replaced, with no error and with the project still saying supports were on.
  const inheritedReplacementOverrides: ObjectProcessOverrides = {}
  if (replacedObjectIds.length > 0) {
    const sourceOverridesByObjectId = new Map<number, Record<string, string>>()
    for (const match of baseModelSettingsXml.matchAll(/<object\b([^>]*)>[\s\S]*?<\/object>/g)) {
      const objectId = Number.parseInt(/(?:^|\s)id="(\d+)"/.exec(match[1] ?? '')?.[1] ?? '', 10)
      if (!Number.isInteger(objectId)) continue
      const overrides = readObjectProcessOverridesFromHead(objectHeadOf(match[0]))
      if (Object.keys(overrides).length > 0) sourceOverridesByObjectId.set(objectId, overrides)
    }
    for (const { originalObjectId, bakedObjectId } of replacedObjectIds) {
      const inherited = sourceOverridesByObjectId.get(originalObjectId)
      if (inherited) inheritedReplacementOverrides[String(bakedObjectId)] = inherited
    }
  }

  // Spread per OBJECT, not per key: a caller's entry is a COMPLETE set by the same contract
  // `applyObjectProcessOverridesXml` writes under, so a key it omits was deliberately cleared and
  // must not be resurrected from the inherited set.
  const objectProcessOverrides = Object.keys(inheritedReplacementOverrides).length > 0
    ? { ...inheritedReplacementOverrides, ...requestObjectProcessOverrides }
    : requestObjectProcessOverrides

  // Triangle paint (support + seam brushes): rewrite painted parts' triangle attributes.
  // Root-entry meshes are rewritten on the already-built model XML; meshes in per-object
  // sub-entries get a transform in the copy pass below.
  const paintChannels: Array<{ attribute: TrianglePaintAttribute; byEntry: Map<string, Map<number, Record<string, string>>> }> = []
  if (source.hasBase) {
    if (edit.supportPaint && edit.supportPaint.length > 0) {
      paintChannels.push({ attribute: 'paint_supports', byEntry: resolvePartPaintByEntry(baseModelXml, edit.supportPaint) })
    }
    if (edit.seamPaint && edit.seamPaint.length > 0) {
      paintChannels.push({ attribute: 'paint_seam', byEntry: resolvePartPaintByEntry(baseModelXml, edit.seamPaint) })
    }
    if (edit.colorPaint && edit.colorPaint.length > 0) {
      paintChannels.push({ attribute: 'paint_color', byEntry: resolvePartPaintByEntry(baseModelXml, edit.colorPaint) })
    }
    if (edit.fuzzyPaint && edit.fuzzyPaint.length > 0) {
      paintChannels.push({ attribute: 'paint_fuzzy_skin', byEntry: resolvePartPaintByEntry(baseModelXml, edit.fuzzyPaint) })
    }
  }
  for (const channel of paintChannels) {
    const rootEntryPaint = channel.byEntry.get('3D/3dmodel.model')
    if (rootEntryPaint) {
      modelXml = applyTrianglePaintToModelEntry(modelXml, channel.attribute, rootEntryPaint)
    }
  }

  // Manual brim ears: when the edit carries the set, the sidecar file is rewritten
  // wholesale (or emptied, clearing the source's ears); absent keeps the source file.
  // Ears authored on a not-yet-saved import are keyed by importId; resolve them onto the object id
  // the import baked as, so they serialize by root-resource ordinal like any other object's.
  const importEars: SceneEditObjectBrimEars[] = (edit.importBrimEars ?? []).flatMap((entry) => {
    const objectId = documents.importIdToObjectId.get(entry.importId)
    return objectId != null ? [{ objectId, points: entry.points }] : []
  })
  const brimEarPointsContent = edit.brimEars !== undefined || importEars.length > 0
    ? serializeBrimEarPoints([...(edit.brimEars ?? []), ...importEars], modelXml)
    : null
  // The old-slot → new-slot permutation this save's filament list implies, or null when slots keep
  // their numbers. Non-null gates every base-content re-key below (untouched plates' tool changes,
  // untouched mesh entries' colour paint, the stale slice_info drop): base bytes stream through
  // the save verbatim otherwise, still speaking the old slot order.
  const slotRemap = edit.filaments && edit.filaments.length > 0 ? filamentSlotIdRemap(edit.filaments) : null
  const basePaintRemap = slotRemap && !isIdentityFilamentSlotRemap(slotRemap) ? slotRemap : null

  // Layer-based filament changes + layer pauses: merged with the source sidecar
  // (preserving unedited entry types and plates); both absent keeps the source file untouched,
  // unless a slot permutation re-keyed the sidecar's tool changes, which must save even without
  // an edit (the merge covers only plates the session touched).
  const baseCustomGcodeForMerge = basePaintRemap && baseCustomGcodeXml !== null
    ? remapCustomGcodeFilamentIds(baseCustomGcodeXml, basePaintRemap)
    : baseCustomGcodeXml
  const customGcodeContent = edit.filamentChanges !== undefined || edit.pauses !== undefined
    ? mergeCustomGcodePerLayer(baseCustomGcodeForMerge, edit.filamentChanges, edit.pauses)
    : (baseCustomGcodeForMerge !== baseCustomGcodeXml ? baseCustomGcodeForMerge : null)
  // Compose project_settings.config rewrites: filament set first (add/remove materials), then the
  // per-slot dual-nozzle assignment, the plate type, and per-plate prime-tower corners. When the
  // base carries no project_settings.config (a new-project scaffold), the composed result is
  // synthesized from an empty settings object instead, otherwise the material / plate-type /
  // prime-tower choices would silently vanish on save (transforms only fire on existing entries).
  const projectSettingsTransforms = buildProjectSettingsTransforms(edit)
  // Global process overrides ride in via options (not the SceneEdit) so only the save route
  // bakes them; append last so they win over any preset-derived process values.
  if (options.globalProcessOverrides && Object.keys(options.globalProcessOverrides).length > 0) {
    const overrides = options.globalProcessOverrides
    projectSettingsTransforms.push((json) => applyGlobalProcessOverrides(json, overrides))
  }
  if (options.objectExportMarker) {
    projectSettingsTransforms.push(applyModelKindMarker)
  }
  /**
   * The settings document this bake actually PRODUCED, captured as it is written.
   *
   * Every invariant check we own inspects a file at rest, which means a defect the bake itself
   * introduces is invisible until someone reopens the project, and two shipped defects reached
   * users exactly that way (a variant-scoped physics drop, and an object left with no material
   * binding). Capturing the output is what lets {@link ThreeMfBakePlan.settingsRepairReasons} judge
   * the bake on its result rather than on its input. Null until the write runs the transform.
   */
  let bakedProjectSettingsJson: string | null = null
  const applyProjectSettings = (json: string) => {
    const baked = projectSettingsTransforms.reduce((acc, transform) => transform(acc), json)
    bakedProjectSettingsJson = baked
    return baked
  }
  const settingsRepairReasons = (): ThreeMfSettingsRepairReason[] => collectSettingsRepairReasons(
    // No transform ran means the bake still WROTE a settings document: the source's, passed through
    // unchanged. Judging null there reports "clean" about a document nothing looked at, and an
    // unknown reported as healthy is the one answer a check like this must never give.
    bakedProjectSettingsJson ?? projectSettingsJson,
    withObjectOverrides(modelSettingsXml, objectProcessOverrides)
  )

  if (source.hasBase) {
    // Copy the base archive, replacing the two edited entries (and adding model_settings if absent).
    // `baseModelSettingsXml` is the placeholder only when the source had no model_settings.config
    // (the read above fell back). Reuse that instead of a 1-byte existence probe, which threw
    // "Entry too large" for every real config and made us append a DUPLICATE entry.
    const hasModelSettings = baseModelSettingsXml !== NEW_PROJECT_MODEL_SETTINGS_XML
    const extraEntries = hasModelSettings
      ? []
      : [{ name: 'Metadata/model_settings.config', content: withObjectOverrides(modelSettingsXml, objectProcessOverrides) }]
    if (brimEarPointsContent !== null) {
      // Replace the entry when the source has one; append it when it doesn't.
      extraEntries.push({ name: BRIM_EAR_POINTS_ENTRY, content: brimEarPointsContent })
    }
    if (customGcodeContent !== null) {
      extraEntries.push({ name: CUSTOM_GCODE_PER_LAYER_ENTRY, content: customGcodeContent })
    }
    // A transform may return null to DROP the entry from the saved 3MF (see rewriteThreeMfEntries).
    const transforms = new Map<string, (xml: string) => string | null>([
      ['3D/3dmodel.model', () => modelXml],
      ['Metadata/model_settings.config', () => withObjectOverrides(modelSettingsXml, objectProcessOverrides)]
    ])
    if (brimEarPointsContent !== null) {
      transforms.set(BRIM_EAR_POINTS_ENTRY, () => brimEarPointsContent)
    }
    if (customGcodeContent !== null) {
      transforms.set(CUSTOM_GCODE_PER_LAYER_ENTRY, () => customGcodeContent)
    }
    // Sidecars addressed by an object's POSITION rather than its id have to follow the objects when
    // the object set changes, or they describe whichever object slid into that slot. We copied them
    // through verbatim, so an ordinary "delete an object" left them pointing at the wrong models on
    // every real project the differential sweep tried that carried one. See
    // `object-ordinal-sidecars.ts` for what BambuStudio then does with a stale entry.
    const baseObjectOrder = parseRootModelObjectIdOrder(baseModelXml)
    const savedObjectOrder = parseRootModelObjectIdOrder(modelXml)
    for (const sidecar of OBJECT_ORDINAL_SIDECAR_ENTRIES) {
      transforms.set(sidecar.path, (content) =>
        remapObjectOrdinalSidecar(content, baseObjectOrder, savedObjectOrder, sidecar.format)
      )
    }
    // Caller-supplied sidecars replace a same-named source entry (transform) and are added
    // when the source lacks them (extraEntries), mirroring the brim/custom-gcode handling.
    for (const entry of options.extraEntries ?? []) {
      transforms.set(entry.name, () => entry.content)
      extraEntries.push(entry)
    }
    // Objects the user marked for mesh repair (editor right-click → "Repair mesh"), resolved to the
    // entries that actually carry their meshes. Repair rewrites in place, so paint and part volumes
    // survive it, which is why repair is a marked edit rather than a geometry replacement.
    const repairMeshesByEntry = resolveRepairMeshesByEntry(baseModelXml, edit.repairedObjectIds ?? [])
    // An inline-mesh object lives in the root entry, whose transform closes over `modelXml`; repair
    // it directly (the closure reads the variable when the copy pass runs).
    const rootRepairIds = repairMeshesByEntry.get('3D/3dmodel.model')
    if (rootRepairIds) {
      const repairedRoot = repairObjectMeshesInModelEntry(modelXml, rootRepairIds)
      if (repairedRoot) modelXml = repairedRoot.xml
    }
    // Parts whose meshes live in per-object sub-entries (Bambu's 3D/Objects/*.model): painted,
    // repaired, or both. One transform per entry composes everything that touches it, in a fixed
    // order: base paint re-key FIRST (a slot permutation must re-key EVERY entry's colour paint,
    // including entries no edit touched, their old-slot codes would otherwise stream through
    // byte-for-byte; parts the session painted arrive in the edit already re-keyed and simply
    // overwrite this), then edit paint, then repair: repair preserves each triangle's attributes
    // while welding/dropping, so painting first rides through it, whereas painting after would
    // index triangles repair removed.
    const touchedEntryPaths = new Set([
      ...(basePaintRemap ? allSubModelPaths(baseModelXml) : []),
      ...paintChannels.flatMap((channel) => [...channel.byEntry.keys()]),
      ...repairMeshesByEntry.keys()
    ])
    touchedEntryPaths.delete('3D/3dmodel.model')
    for (const entryPath of touchedEntryPaths) {
      transforms.set(entryPath, (xml) => {
        const rekeyed = basePaintRemap ? remapColorPaintInModelXml(xml, basePaintRemap) : xml
        const painted = paintChannels.reduce((acc, channel) => {
          const paints = channel.byEntry.get(entryPath)
          return paints ? applyTrianglePaintToModelEntry(acc, channel.attribute, paints) : acc
        }, rekeyed)
        const repairIds = repairMeshesByEntry.get(entryPath)
        if (!repairIds) return painted
        return repairObjectMeshesInModelEntry(painted, repairIds)?.xml ?? painted
      })
    }
    // The project's slicer->runtime nozzle map, needed to move slice_info group ids onto the
    // chosen nozzles. Empty for single-nozzle projects or a from-scratch project with no settings.
    let physicalExtruderMap: string[] = []
    if (projectSettingsJson) {
      try {
        const parsed: unknown = JSON.parse(projectSettingsJson)
        if (parsed && typeof parsed === 'object') physicalExtruderMap = stringArray((parsed as Record<string, unknown>).physical_extruder_map)
      } catch { /* not JSON we can read; leave the nozzle map empty */ }
    }
    if (projectSettingsTransforms.length > 0) {
      if (projectSettingsJson !== null) {
        transforms.set('Metadata/project_settings.config', applyProjectSettings)
      } else {
        // No entry in the base to transform in the copy pass: synthesize one. (If the source
        // somehow does carry the entry despite the failed read above, the copy pass writes the
        // source entry and this extra is skipped by the duplicate-name guard.)
        const synthesized = freshProjectSettings(applyProjectSettings)
        if (synthesized !== null) extraEntries.push({ name: 'Metadata/project_settings.config', content: synthesized })
      }
    }
    // slice_info.config: move each reassigned filament's group_id onto the chosen nozzle so a
    // reopened sliced project reflects the new assignment (group ids outrank filament_nozzle_map
    // once the project carries concrete slice usage). Only when the source shipped slice_info.
    //
    // A record that covers a DIFFERENT filament set than the one being saved is dropped instead.
    // It describes a slice of a project that no longer exists, this save changed the materials,
    // and carrying it forward is not survivable: BambuStudio builds its per-plate nozzle grouping
    // from these entries, so a record listing fewer filaments than the project has makes the
    // engine derive a SHORT filament map and read it out of bounds, aborting the next slice on a
    // garbage extruder id (issue #63). Only the entries can be rewritten here, the per-filament
    // usage a slice produced cannot be invented for a material that was never sliced, so the
    // honest result is no record until the project is sliced again.
    // Which source plate became which saved plate. Null when the edit never says, which is an older
    // client or a hand-built request: the plate records are then left exactly as they were, since
    // the identity mapping we would otherwise assume is precisely the wrong answer for a reorder.
    const plateMapping = sourcePlateMapping(edit.plates)
    if (edit.filaments && edit.filaments.length > 0 && baseSliceInfoXml !== null) {
      const filaments = edit.filaments
      const recordedIds = sliceRecordFilamentIds(baseSliceInfoXml)
      const describesSavedFilaments = recordedIds.length === filaments.length
        && recordedIds.every((id) => id >= 1 && id <= filaments.length)
      // A slot PERMUTATION stales the record even at the same count: its per-id type/colour/usage
      // and group_id describe the old order, and the reader prefers those group ids over
      // `filament_nozzle_map`, so a reopened project would report the pre-reorder nozzle
      // assignment. Same honest answer as the count mismatch, no record until the next slice.
      if (recordedIds.length > 0 && (!describesSavedFilaments || basePaintRemap !== null)) {
        transforms.set(SLICE_INFO_ENTRY, () => null)
      } else {
        // The record survives, so its PLATE numbers have to survive with it. `model_settings`'
        // plates are re-rendered from the edit while this document was copied through verbatim, so
        // after a plate delete or reorder each record bound to whichever plate took its number and
        // reported that plate's weight and time as its own (`plate-metadata.ts`).
        const nozzleRewrite = physicalExtruderMap.length >= 2
          ? (xml: string) => rewriteSliceInfoNozzleGroups(xml, filaments, physicalExtruderMap)
          : null
        if (plateMapping) {
          transforms.set(SLICE_INFO_ENTRY, (xml) => remapSliceInfoPlates(nozzleRewrite ? nozzleRewrite(xml) : xml, plateMapping))
        } else if (nozzleRewrite) {
          transforms.set(SLICE_INFO_ENTRY, nozzleRewrite)
        }
      }
    }
    // Split-out imported sub-models: write each part file and declare it in the sub-model rels so
    // BambuStudio loads them (transform the existing rels, or add a fresh one if the source had none).
    // Embedded project presets the user chose to remove. BambuStudio re-embeds every sidecar it
    // finds on every save (`get_project_embedded_presets`), so one it fabricated once follows the
    // project forever and keeps appearing in the user's filament dropdown; dropping the entry is
    // the only way out. Explicit removals only: see `three-mf/embedded-presets.ts` for why an
    // unreferenced preset is still not ours to delete unasked.
    for (const entryPath of edit.removedEmbeddedPresets ?? []) {
      if (isEmbeddedFilamentPresetEntry(entryPath)) transforms.set(entryPath, () => null)
    }

    if (documents.partFileEntries.length > 0) {
      for (const partFile of documents.partFileEntries) extraEntries.push(partFile)
      const updatedModelRels = appendImportPartRelationships(baseModelRelsXml, documents.partFileEntries)
      if (baseModelRelsXml !== null) {
        transforms.set(THREE_MF_MODEL_RELS_ENTRY, () => updatedModelRels)
      } else {
        extraEntries.push({ name: THREE_MF_MODEL_RELS_ENTRY, content: updatedModelRels })
      }
    }
    return { result, copy: { transforms, appendEntries: extraEntries }, freshEntries: null, settingsRepairReasons }
  }
  return {
    result,
    copy: null,
    settingsRepairReasons,
    freshEntries: [
    { name: '[Content_Types].xml', content: THREE_MF_CONTENT_TYPES_XML },
    { name: '_rels/.rels', content: THREE_MF_RELS_XML },
    { name: '3D/3dmodel.model', content: modelXml },
    { name: 'Metadata/model_settings.config', content: withObjectOverrides(modelSettingsXml, objectProcessOverrides) },
    ...((projectSettingsTransforms.length > 0 ? [freshProjectSettings(applyProjectSettings)] : [])
      .filter((content): content is string => content !== null)
      .map((content) => ({ name: 'Metadata/project_settings.config', content }))),
    ...(brimEarPointsContent ? [{ name: BRIM_EAR_POINTS_ENTRY, content: brimEarPointsContent }] : []),
    ...(customGcodeContent ? [{ name: CUSTOM_GCODE_PER_LAYER_ENTRY, content: customGcodeContent }] : []),
    ...(options.extraEntries ?? [])
    ]
  }
}

/** Apply per-object overrides to a settings document, or pass it through when there are none. */
function withObjectOverrides(modelSettingsXml: string, overrides: ObjectProcessOverrides | undefined): string {
  if (!overrides || Object.keys(overrides).length === 0) return modelSettingsXml
  return applyObjectProcessOverridesXml(modelSettingsXml, overrides)
}
