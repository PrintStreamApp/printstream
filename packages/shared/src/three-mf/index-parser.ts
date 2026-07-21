/**
 * 3MF (Bambu flavor) index parser — the pure string→typed-index core shared by the API
 * (`apps/api/src/lib/three-mf-reader.ts`) and the bridge
 * (`apps/bridge/src/library-3mf.ts`).
 *
 * Library files are bridge-owned by default, so the bridge normally produces the 3MF index the web
 * sees (via the `library.inspect3mf` RPC); the API runs the same parse for the local-copy/fallback
 * path. Both apps used to keep a hand-copied mirror of this logic — this module is the single source
 * of truth so they can never drift. It is deliberately Node-free (pure string/JSON/regex work): the
 * ZIP I/O that feeds it the raw XML/JSON entries stays in each app.
 *
 * The parser is tolerant by design: unknown XML attributes are ignored, and a missing slice-info file
 * falls back to model-settings plate metadata, embedded thumbnails, and finally a synthetic
 * single-plate default so the rest of the UI still works.
 *
 * Output uses the shared `BridgeLibraryThreeMf*` schema types, which are also the RPC contract.
 * When you change the parsed index shape, add the field to `bridgeLibraryThreeMfIndexSchema` (Zod
 * strips anything the schema omits) and bump {@link THREE_MF_INDEX_PARSER_VERSION} so both apps'
 * caches re-derive instead of serving stale indexes.
 */
import { inspectProjectFlushVolumesMatrix } from '../flush-volumes-matrix.js'
import type { PrinterModel } from '../printer.js'
import type {
  BridgeLibraryThreeMfFilament,
  BridgeLibraryThreeMfIndex,
  BridgeLibraryThreeMfObject,
  BridgeLibraryThreeMfPlate,
  BridgeLibraryThreeMfProjectFilament
} from '../bridge-runtime.js'

/**
 * Version of the parsed-index logic. Both apps key their caches on this (the bridge's in-memory LRU
 * and the API's derived-index cache), so bumping it once invalidates stale indexes everywhere.
 * v13: per-plate `filamentChanges`/`pauses` from `custom_gcode_per_layer.xml`.
 * v14: per-filament `isSupport`/`isSoluble` from `filament_is_support`/`filament_soluble`.
 * v15: filament slot count also counts the support/soluble flag arrays (a project whose flags
 *      outran its colours/types/names used to lose its trailing filament slots).
 * v16: `needsSettingsRepair` — flush matrix vs machine topology mismatch (see
 *      flush-volumes-matrix.ts).
 * v17: `projectVersion` — the Bambu Studio version that saved the project, for the
 *      newer-than-the-engine refusal check (see bambu-file-version.ts).
 */
export const THREE_MF_INDEX_PARSER_VERSION = 17

/** Per-plate metadata recovered from `model_settings.config` (labels + object/filament backfill). */
export interface ModelSettingsPlateMetadata {
  index: number
  name: string | null
  thumbnailFile: string | null
  /** Filament ids (extruders) consumed by the objects on this plate, used to back-fill plate
   * filaments for UNSLICED projects whose plates carry no slice_info filament metadata yet. */
  usedFilamentIds: number[]
  /** Objects (by Bambu `object_id`) placed on this plate, for slice-time object selection.
   * Each carries the `identify_id`s of its `model_instance`s on this plate (see
   * {@link BridgeLibraryThreeMfObject}). */
  objects: BridgeLibraryThreeMfObject[]
}

/**
 * The project's support filament ids (`support_filament` / `support_interface_filament`), used as
 * the fallback when an object enables support but doesn't override which filament it uses. Whether a
 * given object actually uses support is read per-object, not from the project default — see
 * {@link parseModelSettingsObjectFilamentIds}.
 */
interface ModelSettingsSupportConfig {
  supportFilamentId: number | null
  supportInterfaceFilamentId: number | null
}

/**
 * Assemble the typed 3MF index from the already-extracted archive entries: the slice-info XML, the
 * project settings JSON, the model-settings plate metadata, the embedded plate thumbnails, and the
 * layer-based custom G-code sidecar (filament changes + pauses; null when the archive has none).
 */
export function buildThreeMfIndex(
  sliceInfoXml: string | null,
  projectSettingsJson: string | null,
  modelSettings: Map<number, string> | ModelSettingsPlateMetadata[] = new Map(),
  thumbnailPlateFiles: Map<number, string> = new Map(),
  customGcodeXml: string | null = null
): BridgeLibraryThreeMfIndex {
  const modelSettingsPlates = Array.isArray(modelSettings)
    ? modelSettings
    : [...modelSettings.entries()].map(([index, name]) => ({ index, name, thumbnailFile: null, usedFilamentIds: [], objects: [] }))
  const projectFilaments = projectSettingsJson ? parseProjectFilaments(projectSettingsJson) : []
  const parsedPlates = sliceInfoXml ? parseSliceInfo(sliceInfoXml) : []
  const plates = parsedPlates.length > 0
    ? parsedPlates
    : modelSettingsPlates.length > 0
      ? buildModelSettingsOnlyPlates(modelSettingsPlates)
    : thumbnailPlateFiles.size > 0
      ? buildThumbnailOnlyPlates(thumbnailPlateFiles)
      : [defaultPlate()]
  const nozzleMap = extractNozzleMapping(projectSettingsJson, sliceInfoXml)
  const compatiblePrinterModels = extractCompatiblePrinterModels(projectSettingsJson, sliceInfoXml)
  const bakedProfiles = extractBakedProfileNames(projectSettingsJson)
  const plateType = extractPlateType(projectSettingsJson)
  const projectNozzleSizes = extractProjectNozzleSizes(projectSettingsJson)
  const projectFilamentMap = new Map(projectFilaments.map((f) => [f.id, f]))
  // Whether a plate generates (manual/auto) support is only decided at slice time, so for
  // UNSLICED projects we can't scope the support material to specific plates. When support is
  // enabled project-wide we therefore surface its dedicated support filament(s) on every plate
  // (see the per-plate loop). Sliced projects carry the authoritative list in slice_info.
  const projectSupport = parseProjectDedicatedSupport(projectSettingsJson)
  // Project-level filaments designated as support material: the `support_filament` /
  // `support_interface_filament` process settings plus any filament flagged
  // `filament_is_support`. Surfaced so consumers (e.g. the editor's remove-guard) know a
  // material is in use as support even though no object's geometry references it directly.
  const projectSupportConfig = parseProjectSupportConfig(projectSettingsJson)
  const supportFilamentIds = [
    ...new Set(
      [
        projectSupportConfig.supportFilamentId,
        projectSupportConfig.supportInterfaceFilamentId,
        ...projectSupport.filamentIds
      ].filter((id): id is number => id != null && id > 0)
    )
  ].sort((left, right) => left - right)
  const usingSliceInfo = parsedPlates.length > 0

  for (const filament of projectFilaments) {
    filament.nozzleId = nozzleMap.get(filament.id) ?? null
  }

  const modelSettingsPlateMap = new Map(modelSettingsPlates.map((plate) => [plate.index, plate]))

  for (const plate of plates) {
    const metadata = modelSettingsPlateMap.get(plate.index)
    if (metadata?.name) plate.name = metadata.name
    if (metadata?.thumbnailFile && !plate.thumbnailFile) plate.thumbnailFile = metadata.thumbnailFile
    // Prefer model_settings objects over slice_info's: their ids are the model `object_id`
    // used everywhere downstream (scene instances, slice-time model_instance removal, and
    // per-object overrides), whereas slice_info lists objects by `identify_id` — a different
    // id space that wouldn't match the instances, breaking the per-object print toggle and
    // ghosting the whole model. Fall back to slice_info objects only when model_settings has none.
    if ((metadata?.objects.length ?? 0) > 0) {
      plate.objects = metadata!.objects
    }
    if (plate.filaments.length === 0 && (metadata?.usedFilamentIds.length ?? 0) > 0) {
      plate.filaments = metadata?.usedFilamentIds.map((id) => ({
        id,
        filamentType: null,
        filamentName: null,
        color: null,
        usedGrams: null,
        usedMeters: null,
        nozzleId: null,
        nozzleDiameter: null,
        chamberTemperature: null
      })) ?? []
    }
    // Project-wide support: add the dedicated support material(s) to every unsliced plate so they
    // can be assigned/mapped, even though we can't tell pre-slice which plates actually use them.
    // Only filaments flagged `filament_is_support` are added — never the support-BASE color — so a
    // regular print colour never appears "used" on a plate whose geometry doesn't use it.
    if (!usingSliceInfo && projectSupport.enabled) {
      for (const supportFilamentId of projectSupport.filamentIds) {
        if (plate.filaments.some((filament) => filament.id === supportFilamentId)) continue
        plate.filaments.push({
          id: supportFilamentId,
          filamentType: null,
          filamentName: null,
          color: null,
          usedGrams: null,
          usedMeters: null,
          nozzleId: null,
          nozzleDiameter: null,
          chamberTemperature: null
        })
      }
      plate.filaments.sort((left, right) => left.id - right.id)
    }
    plate.plateType = plateType
    // Unsliced plates have no slice_info nozzle metadata; show the project's configured
    // nozzle diameters instead so 3MFs get the same nozzle chips as sliced files.
    if (plate.nozzleSizes.length === 0 && projectNozzleSizes.length > 0) {
      plate.nozzleSizes = [...projectNozzleSizes]
    }
    // Baked layer G-code (filament changes / pauses), so pre-slice surfaces can show and
    // edit them without opening the archive again. Omitted (not []) when the sidecar has
    // no entries for the plate — absent and empty mean the same downstream.
    if (customGcodeXml) {
      const changes = parseCustomGcodeToolChanges(customGcodeXml, plate.index)
      if (changes.length > 0) plate.filamentChanges = changes.map(({ z, filamentId }) => ({ z, filamentId }))
      const pauses = parseCustomGcodePauses(customGcodeXml, plate.index)
      if (pauses.length > 0) plate.pauses = pauses
    }
    for (const filament of plate.filaments) {
      if (!filament.filamentName) {
        filament.filamentName = projectFilamentMap.get(filament.id)?.filamentName ?? null
      }
      filament.nozzleId = nozzleMap.get(filament.id) ?? null
      filament.chamberTemperature = projectFilamentMap.get(filament.id)?.chamberTemperature ?? null
    }
  }

  // Geometry-only 3MF: no Bambu project metadata at all — neither slice_info nor
  // model_settings produced a plate (the plates above are fabricated placeholders).
  // Such a file is a mesh container (a vanilla CAD export), not an openable project:
  // the editor's scene parse requires model_settings, so consumers route these files
  // down the STL/STEP mesh paths (preview, mesh thumbnail, import-into-project)
  // instead of the project editor. An editor "New 3MF" scaffold always writes
  // model_settings, so self-authored projects can never classify as geometry-only.
  const geometryOnly = parsedPlates.length === 0 && modelSettingsPlates.length === 0
  const objectExport = extractModelKindMarker(projectSettingsJson) === PRINTSTREAM_MODEL_KIND_OBJECT_EXPORT
  // The project's embedded settings contradict its own machine topology, which makes BambuStudio
  // read out of bounds and abort the slice (see flush-volumes-matrix.ts). Surfaced so the editor
  // and the slice dialog can offer a repair instead of letting the user hit an opaque CLI crash;
  // nothing repairs it automatically — the file is only rewritten when the user asks.
  const needsSettingsRepair = inspectProjectFlushVolumesMatrix(projectSettingsJson)?.inconsistent === true
  // The Bambu Studio build that saved this project. BambuStudio REFUSES to open a project from a
  // newer version than the engine slicing it (major.minor only — see bambu-file-version.ts), so
  // the slice dialog needs this to warn before the user burns a job on an exit-232 refusal.
  const projectVersion = extractProjectVersion(projectSettingsJson)

  return { plates, projectFilaments, compatiblePrinterModels, supportFilamentIds, geometryOnly, objectExport, needsSettingsRepair, projectVersion, ...bakedProfiles }
}

/**
 * `project_settings.config` key the editor's single-object export stamps on its output
 * (value {@link PRINTSTREAM_MODEL_KIND_OBJECT_EXPORT}). Such a file is a full Bambu
 * project by construction — that is what preserves the object's parts/materials/paint —
 * but it exists to be a reusable MODEL, so the library's default treatment is model-like
 * (preview on click) while project capabilities (slice/edit) stay reachable from menus.
 * BambuStudio tolerates the foreign key: its JSON config loader records unrecognized
 * keys and skips them (the same forward-compatibility path newer-Studio files rely on).
 * Writer counterpart: `applyModelKindMarker` in the API's `three-mf-scene-builder.ts`.
 */
export const PRINTSTREAM_MODEL_KIND_KEY = 'printstream_model_kind'
export const PRINTSTREAM_MODEL_KIND_OBJECT_EXPORT = 'object-export'

function extractModelKindMarker(projectSettingsJson: string | null): string | null {
  if (!projectSettingsJson) return null
  try {
    const parsed = JSON.parse(projectSettingsJson) as Record<string, unknown>
    const value = parsed?.[PRINTSTREAM_MODEL_KIND_KEY]
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

export function defaultPlate(): BridgeLibraryThreeMfPlate {
  return {
    index: 1,
    name: null,
    gcodeFile: 'Metadata/plate_1.gcode',
    pickFile: 'Metadata/pick_1.png',
    thumbnailFile: 'Metadata/plate_1.png',
    plateType: null,
    nozzleSizes: [],
    filaments: [],
    objects: []
  }
}

export function buildThumbnailOnlyPlates(thumbnailPlateFiles: Map<number, string>): BridgeLibraryThreeMfPlate[] {
  return [...thumbnailPlateFiles].map(([index, thumbnailFile]) => ({
    index,
    name: null,
    gcodeFile: `Metadata/plate_${index}.gcode`,
    pickFile: buildDefaultPickFilePath(index),
    thumbnailFile,
    plateType: null,
    nozzleSizes: [],
    filaments: [],
    objects: []
  }))
}

export function buildModelSettingsOnlyPlates(plates: ModelSettingsPlateMetadata[]): BridgeLibraryThreeMfPlate[] {
  return plates.map((plate) => ({
    index: plate.index,
    name: plate.name,
    gcodeFile: `Metadata/plate_${plate.index}.gcode`,
    pickFile: buildDefaultPickFilePath(plate.index),
    thumbnailFile: plate.thumbnailFile ?? `Metadata/plate_${plate.index}.png`,
    plateType: null,
    nozzleSizes: [],
    filaments: plate.usedFilamentIds.map((id) => ({
      id,
      filamentType: null,
      filamentName: null,
      color: null,
      usedGrams: null,
      usedMeters: null,
      nozzleId: null,
      nozzleDiameter: null,
      chamberTemperature: null
    })),
    objects: plate.objects
  }))
}

export function buildDefaultPickFilePath(plateIndex: number): string {
  return `Metadata/pick_${plateIndex}.png`
}

/**
 * Parse Bambu Studio's `slice_info.config` XML. Format (excerpt):
 *
 *   <plate>
 *     <metadata key="index" value="1"/>
 *     <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>
 *     <filament id="1" type="PLA" color="#ABCDEF" used_g="12.34" used_m="4.56"/>
 *     ...
 *   </plate>
 *
 * Implemented with a small regex pass. The file is tightly controlled
 * by Bambu Studio output and never user-edited, so a forgiving regex is
 * good enough and avoids pulling in an XML parser dep.
 */
function parseSliceInfo(xml: string): BridgeLibraryThreeMfPlate[] {
  const plates: BridgeLibraryThreeMfPlate[] = []
  const plateBlocks = xml.match(/<plate\b[^>]*>[\s\S]*?<\/plate>/g) ?? []
  for (const block of plateBlocks) {
    const meta = new Map<string, string>()
    for (const match of block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
      const key = match[1]
      const value = match[2]
      if (key != null && value != null) meta.set(key, decodeXmlAttributeValue(value))
    }
    const filaments: BridgeLibraryThreeMfFilament[] = []
    for (const match of block.matchAll(/<filament\b([^/>]*)\/?>(?:<\/filament>)?/g)) {
      const attrs = parseAttrs(match[1] ?? '')
      filaments.push({
        id: parseInt(attrs.id ?? '0', 10) || filaments.length + 1,
        filamentType: attrs.type ?? null,
        filamentName: null,
        color: normalizeColor(attrs.color),
        nozzleId: null,
        nozzleDiameter: normalizeNozzleDiameter(attrs.nozzle_diameter),
        chamberTemperature: null,
        usedGrams: numOrNull(attrs.used_g),
        usedMeters: numOrNull(attrs.used_m)
      })
    }
    const objects: BridgeLibraryThreeMfObject[] = []
    for (const match of block.matchAll(/<object\b([^/>]*)\/?>(?:<\/object>)?/g)) {
      const attrs = parseAttrs(match[1] ?? '')
      const identifyIdValue = parseInt(attrs.identify_id ?? '', 10)
      const idValue = Number.isFinite(identifyIdValue) ? identifyIdValue : parseInt(attrs.id ?? '', 10)
      const name = attrs.name?.trim()
      if (!name) continue
      objects.push({
        id: Number.isFinite(idValue) ? idValue : objects.length + 1,
        name,
        // slice_info lists one entry per instance keyed by identify_id, so when that
        // attribute is present the entry's firmware skip handle is the id itself.
        identifyIds: Number.isFinite(identifyIdValue) ? [identifyIdValue] : []
      })
    }
    const indexValue = parseInt(meta.get('index') ?? '0', 10)
    const index = Number.isFinite(indexValue) && indexValue > 0 ? indexValue : plates.length + 1
    plates.push({
      index,
      name: meta.get('plater_name') || meta.get('name') || null,
      gcodeFile: meta.get('gcode_file') ?? `Metadata/plate_${index}.gcode`,
      pickFile: meta.get('pick_file') ?? buildDefaultPickFilePath(index),
      thumbnailFile: meta.get('thumbnail_file') ?? `Metadata/plate_${index}.png`,
      plateType: null,
      nozzleSizes: collectPlateNozzleSizes(meta.get('nozzle_diameters'), filaments),
      filaments,
      objects,
      prediction: numOrNull(meta.get('prediction')),
      weight: numOrNull(meta.get('weight'))
    })
  }
  plates.sort((a, b) => a.index - b.index)
  return plates
}

/**
 * Parse `project_settings.config` (JSON) for the project's global filament
 * list. Bambu Studio writes parallel arrays — `filament_colour`,
 * `filament_type`, `filament_ids`, `filament_settings_id` — keyed by 0-based
 * index. We expose them as 1-based ids to match the references in
 * `slice_info.config`'s `<filament id="N" .../>` entries.
 */
export function parseProjectFilaments(json: string): BridgeLibraryThreeMfProjectFilament[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const colors = stringArray(record.filament_colour)
  const types = stringArray(record.filament_type)
  const names = stringArray(record.filament_settings_id)
  const chamberTemperatures = nullableNumberArray(record.chamber_temperatures)
  // Per-slot material CHARACTER, parallel '0'/'1' arrays alongside filament_type. Distinct from
  // the index's `supportFilamentIds`, which also folds in whichever slots the support_filament /
  // support_interface_filament settings currently point at: these flags describe the material
  // itself, so classification (see `support-recommendations.ts`) must read them, not that union.
  const supportFlags = stringArray(record.filament_is_support)
  const solubleFlags = stringArray(record.filament_soluble)
  // Every parallel array counts toward the slot total, including the support/soluble
  // flags: omitting them truncated the filament list whenever they were the longest,
  // and those flags now drive preset filtering (`resolveDisplayFilamentType`).
  const length = Math.max(colors.length, types.length, names.length, chamberTemperatures.length, supportFlags.length, solubleFlags.length)
  const out: BridgeLibraryThreeMfProjectFilament[] = []
  for (let i = 0; i < length; i++) {
    out.push({
      id: i + 1,
      filamentType: types[i] ?? null,
      filamentName: cleanFilamentName(names[i]) ?? null,
      color: normalizeColor(colors[i]),
      nozzleId: null,
      chamberTemperature: chamberTemperatures[i] ?? null,
      isSupport: configFlag(supportFlags[i]),
      isSoluble: configFlag(solubleFlags[i])
    })
  }
  return out
}

/**
 * Read one entry of a BambuStudio '0'/'1' flag array. Null (rather than false) when the slot is
 * absent, so consumers can tell "the project said no" from "the project never said", and fall
 * back to their own heuristics only in the latter case.
 */
function configFlag(value: string | undefined): boolean | null {
  if (value === undefined) return null
  return value === '1'
}

export function nullableNumberArray(value: unknown): Array<number | null> {
  return Array.isArray(value)
    ? value.map((entry) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) return entry
      if (typeof entry === 'string') {
        const parsed = Number.parseFloat(entry)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    })
    : []
}

export function extractPlateType(projectSettingsJson: string | null): string | null {
  if (!projectSettingsJson) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  return typeof record.curr_bed_type === 'string'
    ? normalizePlateType(record.curr_bed_type)
    : null
}

/**
 * The Bambu Studio version stamped into `project_settings.config` (`version`, zero-padded like
 * `"02.08.00.50"`). Mirrors the `3D/3dmodel.model` `Application` metadata; project_settings is used
 * because the parser already receives it. Null when absent or unparseable — callers must treat that
 * as "unknown" and never as "compatible".
 */
export function extractProjectVersion(projectSettingsJson: string | null): string | null {
  if (!projectSettingsJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const raw = (parsed as Record<string, unknown>).version
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return /^\d+(\.\d+)*$/.test(trimmed) ? trimmed : null
}

/**
 * Project-level nozzle diameters (`nozzle_diameter`, one entry per extruder) from
 * project settings. Used to backfill plate nozzle sizes for UNSLICED projects, whose
 * plates carry no slice_info `nozzle_diameters` metadata yet.
 */
export function extractProjectNozzleSizes(projectSettingsJson: string | null): string[] {
  if (!projectSettingsJson) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const raw = Array.isArray(record.nozzle_diameter) ? record.nozzle_diameter : []
  const sizes = new Set<string>()
  for (const entry of raw) {
    const normalized = normalizeNozzleDiameter(typeof entry === 'string' || typeof entry === 'number' ? String(entry) : undefined)
    if (normalized) sizes.add(normalized)
  }
  return [...sizes]
}

function extractBakedProfileNames(projectSettingsJson: string | null): { printerProfileName: string | null; processProfileName: string | null } {
  if (!projectSettingsJson) return { printerProfileName: null, processProfileName: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return { printerProfileName: null, processProfileName: null }
  }
  if (!parsed || typeof parsed !== 'object') return { printerProfileName: null, processProfileName: null }
  const record = parsed as Record<string, unknown>
  return {
    printerProfileName: firstStringValue(record.printer_settings_id),
    processProfileName: firstStringValue(record.print_settings_id) ?? firstStringValue(record.default_print_profile)
  }
}

export function firstStringValue(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function collectPlateNozzleSizes(metaValue: string | undefined, filaments: BridgeLibraryThreeMfFilament[]): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()

  const push = (value: string | null) => {
    if (!value || seen.has(value)) return
    seen.add(value)
    ordered.push(value)
  }

  for (const match of (metaValue ?? '').match(/\d+(?:\.\d+)?/g) ?? []) {
    push(normalizeNozzleDiameter(match))
  }
  for (const filament of filaments) {
    push(filament.nozzleDiameter)
  }

  return ordered
}

/**
 * Extract per-filament nozzle assignments for dual-nozzle files.
 *
 * The slicer writes two useful hints into `project_settings.config`:
 * `physical_extruder_map` remaps slicer extruders to MQTT extruder ids,
 * while `filament_nozzle_map` is the user's saved preference. When
 * `slice_info.config` carries `group_id` on `<filament>` elements, that is
 * the stronger signal because it reflects the actual sliced assignment.
 */
function extractNozzleMapping(
  projectSettingsJson: string | null,
  sliceInfoXml: string | null
): Map<number, number> {
  if (!projectSettingsJson) return new Map()

  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return new Map()
  }
  if (!parsed || typeof parsed !== 'object') return new Map()

  const record = parsed as Record<string, unknown>
  const physicalExtruderMap = stringArray(record.physical_extruder_map)
  const normalizeTarget = (target: number) => normalizeProjectNozzleTarget(target, physicalExtruderMap)
  if (physicalExtruderMap.length <= 1) return new Map()
  const filamentNozzleMap = stringArray(record.filament_nozzle_map)
  const sliceFilamentIds = sliceInfoXml ? extractSliceFilamentIds(sliceInfoXml) : []
  const hasSliceFilamentAssignments = sliceFilamentIds.length > 0

  const mapping = new Map<number, number>()
  const activeExtruders = stringArray(record.extruder_nozzle_stats).map((stats) =>
    stats
      .split('|')
      .map((entry) => entry.split('#')[1] ?? '')
      .some((count) => count !== '' && count !== '0')
  )

  if (activeExtruders.filter(Boolean).length === 1) {
    const activeIndex = activeExtruders.findIndex(Boolean)
    const target = numberAt(physicalExtruderMap, activeIndex)
    if (target !== null) {
      if (sliceFilamentIds.length > 0) {
        for (const filamentId of sliceFilamentIds) mapping.set(filamentId, normalizeTarget(target))
        return mapping
      }
      const fallbackLength = filamentNozzleMap.length
      for (let i = 0; i < fallbackLength; i++) mapping.set(i + 1, normalizeTarget(target))
      return mapping
    }
  }

  const mappingFromFilamentNozzleMap = new Map<number, number>()
  for (let i = 0; i < filamentNozzleMap.length; i++) {
    const filamentTarget = numberAt(filamentNozzleMap, i)
    const target = filamentTarget === null
      ? null
      : hasSliceFilamentAssignments
        ? numberAt(physicalExtruderMap, filamentTarget)
        : filamentTarget
    if (target !== null) mappingFromFilamentNozzleMap.set(i + 1, normalizeTarget(target))
  }

  if (sliceInfoXml) {
    for (const match of sliceInfoXml.matchAll(/<filament\b([^/>]*)\/?>(?:<\/filament>)?/g)) {
      const attrs = parseAttrs(match[1] ?? '')
      const filamentId = parseInt(attrs.id ?? '', 10)
      const groupId = parseInt(attrs.group_id ?? '', 10)
      const target = numberAt(physicalExtruderMap, groupId)
      if (Number.isFinite(filamentId) && filamentId > 0 && target !== null) {
        mapping.set(filamentId, normalizeTarget(target))
      }
    }
  }
  if (mapping.size > 0) {
    if (shouldPreferFilamentNozzleMap(physicalExtruderMap, mapping, mappingFromFilamentNozzleMap, sliceInfoXml)) {
      return mappingFromFilamentNozzleMap
    }
    // `slice_info` only lists the filaments its LAST SLICE used, so on a project sliced before a
    // material was added it is authoritative but incomplete. Keep its precedence for the filaments
    // it knows about, and fall back to `filament_nozzle_map` for the ones it predates — returning
    // it alone dropped those, so a nozzle the user picked and saved (correctly written to
    // `filament_nozzle_map`) read back as "no nozzle" forever, and the next save wrote that
    // nothing straight back into the file.
    //
    // Those fallback entries are read VERBATIM as runtime nozzle ids, not through
    // `physical_extruder_map`: a slot slice_info never covered was written by our own editor save
    // (`applyNozzleAssignmentToProjectSettings`), which stores the runtime id directly. The
    // remapping above applies to slots BambuStudio itself authored alongside slice_info.
    const merged = new Map(mapping)
    for (let i = 0; i < filamentNozzleMap.length; i++) {
      const filamentId = i + 1
      if (merged.has(filamentId)) continue
      const runtimeNozzleId = numberAt(filamentNozzleMap, i)
      if (runtimeNozzleId !== null) merged.set(filamentId, runtimeNozzleId)
    }
    return merged
  }

  if (mappingFromFilamentNozzleMap.size > 0) return mappingFromFilamentNozzleMap

  return new Map()
}

/**
 * BambuStudio dual-nozzle projects can encode identity `physical_extruder_map`
 * while filament assignments are emitted in left-to-right UI order. Convert
 * those targets into printer/runtime nozzle ids (right=0, left=1).
 */
function normalizeProjectNozzleTarget(target: number, physicalExtruderMap: string[]): number {
  if (target !== 0 && target !== 1) return target
  if (!usesUiOrderedDualNozzleTargets(physicalExtruderMap)) return target
  return target === 0 ? 1 : 0
}

function usesUiOrderedDualNozzleTargets(physicalExtruderMap: string[]): boolean {
  if (physicalExtruderMap.length !== 2) return false
  return numberAt(physicalExtruderMap, 0) === 0 && numberAt(physicalExtruderMap, 1) === 1
}

/**
 * The slicer-extruder index (a `slice_info` `group_id` / `filament_nozzle_map` slot value)
 * that feeds runtime nozzle `nozzleId` (0 = right, 1 = left) on the project's machine. This is
 * the exact inverse of {@link normalizeProjectNozzleTarget}: it finds the extruder slot `g`
 * whose `physical_extruder_map[g]`, normalized, equals `nozzleId`, so a value written to
 * `group_id`/`filament_nozzle_map` round-trips back to `nozzleId` through `extractNozzleMapping`.
 * The writer that persists an editor nozzle change (`apps/api/src/lib/three-mf-scene-builder.ts`)
 * uses it to keep the read and write paths inverse-free mirrors. Returns null for single-nozzle
 * projects (`physical_extruder_map` shorter than 2) or when no extruder feeds that nozzle.
 */
export function sliceExtruderForNozzleId(nozzleId: number, physicalExtruderMap: string[]): number | null {
  if (physicalExtruderMap.length < 2) return null
  for (let extruder = 0; extruder < physicalExtruderMap.length; extruder++) {
    const runtime = numberAt(physicalExtruderMap, extruder)
    if (runtime === null) continue
    if (normalizeProjectNozzleTarget(runtime, physicalExtruderMap) === nozzleId) return extruder
  }
  return null
}

function shouldPreferFilamentNozzleMap(
  physicalExtruderMap: string[],
  mappingFromSliceInfo: ReadonlyMap<number, number>,
  mappingFromFilamentNozzleMap: ReadonlyMap<number, number>,
  sliceInfoXml: string | null
): boolean {
  if (mappingFromFilamentNozzleMap.size === 0) return false
  if (!hasNonIdentityPhysicalExtruderMap(physicalExtruderMap)) return false
  if (sliceInfoHasConcreteFilamentUsage(sliceInfoXml)) return false

  for (const [filamentId, sliceTarget] of mappingFromSliceInfo.entries()) {
    const filamentTarget = mappingFromFilamentNozzleMap.get(filamentId)
    if (filamentTarget != null && filamentTarget !== sliceTarget) return true
  }
  return false
}

function hasNonIdentityPhysicalExtruderMap(physicalExtruderMap: string[]): boolean {
  for (let index = 0; index < physicalExtruderMap.length; index++) {
    const target = numberAt(physicalExtruderMap, index)
    if (target != null && target !== index) return true
  }
  return false
}

function sliceInfoHasConcreteFilamentUsage(sliceInfoXml: string | null): boolean {
  if (!sliceInfoXml) return false
  for (const match of sliceInfoXml.matchAll(/<filament\b([^/>]*)\/?>(?:<\/filament>)?/g)) {
    const attrs = parseAttrs(match[1] ?? '')
    if (
      attrs.used_g != null
      || attrs.used_m != null
      || attrs.used_for_object != null
      || attrs.used_for_support != null
      || attrs.tray_info_idx != null
    ) {
      return true
    }
  }
  return false
}

/**
 * The 1-based filament ids a `slice_info.config` record covers, ascending.
 *
 * `slice_info.config` describes a PREVIOUS slice: one `<filament>` entry per filament that slice
 * used. Callers writing a 3MF use this to check the record still describes the project's current
 * filament set — BambuStudio builds its per-plate nozzle grouping from these entries, so a record
 * covering a different set makes the engine derive a mismatched filament map (a SHORTER one is an
 * out-of-bounds read that aborts the slice; see docs/slicer-architecture.md).
 */
export function sliceRecordFilamentIds(xml: string): number[] {
  return extractSliceFilamentIds(xml)
}

function extractSliceFilamentIds(xml: string): number[] {
  const ids = new Set<number>()
  for (const match of xml.matchAll(/<filament\b([^/>]*)\/?>(?:<\/filament>)?/g)) {
    const attrs = parseAttrs(match[1] ?? '')
    const filamentId = parseInt(attrs.id ?? '', 10)
    if (Number.isFinite(filamentId) && filamentId > 0) ids.add(filamentId)
  }
  return Array.from(ids.values()).sort((left, right) => left - right)
}

function extractCompatiblePrinterModels(
  projectSettingsJson: string | null,
  sliceInfoXml: string | null
): PrinterModel[] {
  const models = new Set<PrinterModel>()

  if (projectSettingsJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(projectSettingsJson)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      collectNormalizedModels(record.printer_model, models)
      collectNormalizedModels(record.printer_settings_id, models)
      collectNormalizedModels(record.compatible_printers, models)
      collectNormalizedModels(record.print_compatible_printers, models)
      collectNormalizedModels(record.models, models)
    }
  }

  if (sliceInfoXml) {
    for (const match of sliceInfoXml.matchAll(/<metadata\s+key="printer_model_id"\s+value="([^"]+)"\s*\/>/g)) {
      const normalized = normalizePrinterModelId(match[1])
      if (normalized) models.add(normalized)
    }
  }

  return Array.from(models)
}

/**
 * Collect normalized printer models out of a project-settings value (used both for the index's
 * `compatiblePrinterModels` and the scene reader's bed fallback). Exported for the scene reader.
 */
export function collectNormalizedModels(value: unknown, models: Set<PrinterModel>): void {
  if (typeof value === 'string') {
    for (const entry of parseSerializedModelValues(value)) {
      const normalized = normalizePrinterModelName(entry)
      if (normalized) models.add(normalized)
    }
    return
  }
  if (!Array.isArray(value)) return
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    for (const candidate of parseSerializedModelValues(entry)) {
      const normalized = normalizePrinterModelName(candidate)
      if (normalized) models.add(normalized)
    }
  }
}

/**
 * Longest printer-model value worth parsing. Real `printer_model` /
 * `compatible_printers` values are at most a few KB; the cap keeps the
 * forgiving regexes below from backtracking over a pathological entry.
 */
const SERIALIZED_MODEL_VALUE_LIMIT = 64 * 1024

function parseSerializedModelValues(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > SERIALIZED_MODEL_VALUE_LIMIT) return []

  const bracketedMatches = Array.from(trimmed.matchAll(/\[([^\]]+)\]/g), (match) => match[1]?.trim() ?? '')
    .filter(Boolean)
    .map((entry) => entry.replace(/\+\+.*$/, '').trim())
    .filter(Boolean)
  if (bracketedMatches.length > 0) return bracketedMatches

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
      }
    } catch {
      // Fall through to delimiter-based parsing.
    }
  }

  return trimmed
    .split(/[;\n,]+/)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

function normalizePrinterModelId(value: string | undefined): PrinterModel | null {
  if (!value) return null
  const key = value.trim().toUpperCase()
  const mapped: Partial<Record<string, PrinterModel>> = {
    C11: 'X1C',
    C13: 'X1E',
    N6: 'X2D',
    P1S: 'P1S',
    P2S: 'P2S',
    P1P: 'P1P',
    A11: 'A1',
    N1: 'A1',
    A12: 'A1mini',
    A04: 'A1mini',
    N2S: 'A1mini',
    N9: 'A2L',
    O1D: 'H2D',
    'BL-D001': 'H2D',
    H2DPRO: 'H2DPRO',
    O1C: 'H2C',
    O1C2: 'H2C',
    H2S: 'H2S'
  }
  return mapped[key] ?? null
}

/** Normalize a free-form printer model string into a known {@link PrinterModel}. Exported for the scene reader. */
export function normalizePrinterModelName(value: string | undefined): PrinterModel | null {
  if (!value) return null
  const canonical = value
    .replace(/^#\s*/, '')
    .replace(/@BBL\b.*$/i, '')
    .replace(/\b\d+(?:\.\d+)?\s*NOZZLE\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

  if (!canonical) return null
  if (canonical.includes('X1E')) return 'X1E'
  if (canonical.includes('X1 CARBON') || canonical.includes('X1C')) return 'X1C'
  if (canonical.includes('X2D')) return 'X2D'
  if (canonical.includes('P1S')) return 'P1S'
  if (canonical.includes('P2S')) return 'P2S'
  if (canonical.includes('P1P')) return 'P1P'
  if (canonical.includes('A2L')) return 'A2L'
  // A1 mini MUST be tested before A1: "BAMBU LAB A1 MINI" contains " A1 " and would
  // otherwise classify as A1 — which made the slice dialog auto-match A1 filament
  // profiles against the project's A1-mini machine profile and fail the CLI (#28).
  if (canonical.includes('A1 MINI') || canonical.includes('A1MINI')) return 'A1mini'
  if (/(^|[^A-Z0-9])A1($|[^A-Z0-9])/.test(canonical)) return 'A1'
  if (canonical.includes('H2C')) return 'H2C'
  if (canonical.includes('H2D PRO') || canonical.includes('H2DPRO')) return 'H2DPRO'
  if (canonical.includes('H2S')) return 'H2S'
  if (canonical.includes('H2D')) return 'H2D'
  return normalizePrinterModelId(canonical)
}

/**
 * Inner bodies of every `<tag ...>...</tag>` element, located with indexOf
 * scans so an adversarial (unclosed / repeated) uploaded document stays
 * linear instead of triggering regex backtracking.
 */
function extractTagBlocks(xml: string, tag: string): string[] {
  const open = `<${tag}`
  const close = `</${tag}>`
  const out: string[] = []
  let cursor = 0
  while (true) {
    const start = xml.indexOf(open, cursor)
    if (start < 0) break
    const afterName = xml.charAt(start + open.length)
    if (afterName !== '' && afterName !== '>' && afterName !== '/' && !/\s/.test(afterName)) {
      cursor = start + open.length
      continue
    }
    const openEnd = xml.indexOf('>', start + open.length)
    if (openEnd < 0) break
    const end = xml.indexOf(close, openEnd + 1)
    if (end < 0) break
    out.push(xml.slice(openEnd + 1, end))
    cursor = end + close.length
  }
  return out
}

/**
 * Parse Bambu Studio's `model_settings.config` for per-plate labels and the
 * object filament ids that still matter when `slice_info.config` is absent.
 */
export function parseModelSettingsPlates(xml: string, projectSettingsJson: string | null = null): ModelSettingsPlateMetadata[] {
  const supportConfig = parseProjectSupportConfig(projectSettingsJson)
  const objectExtrudersById = parseModelSettingsObjectFilamentIds(xml, supportConfig)
  const objectNamesById = parseModelSettingsObjectNames(xml)
  const out: ModelSettingsPlateMetadata[] = []
  const plateBlocks = xml.match(/<plate\b[^>]*>[\s\S]*?<\/plate>/g) ?? []
  for (const block of plateBlocks) {
    const meta = new Map<string, string>()
    for (const match of block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
      const key = match[1]
      const value = match[2]
      if (key != null && value != null) meta.set(key, decodeXmlAttributeValue(value))
    }
    const id = parseInt(meta.get('plater_id') ?? '0', 10)
    if (!Number.isFinite(id) || id <= 0) continue
    const name = meta.get('plater_name')?.trim() ?? ''
    const usedFilamentIds = new Set<number>()
    const objects: BridgeLibraryThreeMfObject[] = []
    const objectsById = new Map<number, BridgeLibraryThreeMfObject>()
    for (const instanceBody of extractTagBlocks(block, 'model_instance')) {
      const objectId = Number.parseInt(instanceBody.match(/<metadata\s+key="object_id"\s+value="(\d+)"\s*\/>/)?.[1] ?? '', 10)
      if (!Number.isInteger(objectId) || objectId <= 0) continue
      for (const extruderId of objectExtrudersById.get(objectId) ?? []) {
        if (extruderId > 0) usedFilamentIds.add(extruderId)
      }
      // One entry per object (object_id), even when it has multiple instances on the plate;
      // slice-time selection operates at object granularity. Every instance's identify_id
      // (the per-instance handle firmware `skip_objects` keys on) is collected onto the
      // object's entry so consumers can map object -> skip handles without re-reading the file.
      let object = objectsById.get(objectId)
      if (!object) {
        object = { id: objectId, name: objectNamesById.get(objectId) ?? `Object ${objectId}`, identifyIds: [] }
        objectsById.set(objectId, object)
        objects.push(object)
      }
      const identifyId = Number.parseInt(instanceBody.match(/<metadata\s+key="identify_id"\s+value="(\d+)"\s*\/>/)?.[1] ?? '', 10)
      if (Number.isInteger(identifyId) && !object.identifyIds.includes(identifyId)) {
        object.identifyIds.push(identifyId)
      }
    }
    out.push({
      index: id,
      name: name || null,
      thumbnailFile: meta.get('thumbnail_file') ?? null,
      usedFilamentIds: [...usedFilamentIds].sort((left, right) => left - right),
      objects
    })
  }
  return out.sort((left, right) => left.index - right.index)
}

/**
 * Map each `<object id="N">` in `model_settings.config` to its display name (the object's own
 * `name` metadata, which precedes any `<part>` names in the block).
 */
function parseModelSettingsObjectNames(xml: string): Map<number, string> {
  const names = new Map<number, string>()
  for (const block of xml.match(/<object\b[^>]*>[\s\S]*?<\/object>/g) ?? []) {
    const objectId = Number.parseInt(parseAttrs(block.match(/^<object\b([^>]*)>/)?.[1] ?? '').id ?? '', 10)
    if (!Number.isInteger(objectId) || objectId <= 0) continue
    const name = readModelSettingsMetadataString(block, 'name')
    if (name) names.set(objectId, name)
  }
  return names
}

function parseModelSettingsObjectFilamentIds(
  xml: string,
  projectSupportConfig: ModelSettingsSupportConfig
): Map<number, number[]> {
  const objectExtrudersById = new Map<number, number[]>()
  const objectBlocks = xml.match(/<object\b[^>]*>[\s\S]*?<\/object>/g) ?? []
  for (const block of objectBlocks) {
    const attrs = parseAttrs(block.match(/^<object\b([^>]*)>/)?.[1] ?? '')
    const objectId = Number.parseInt(attrs.id ?? '', 10)
    if (!Number.isInteger(objectId) || objectId <= 0) continue
    const extruderIds = new Set<number>()
    for (const match of block.matchAll(/<metadata\s+key="extruder"\s+value="(\d+)"\s*\/>/g)) {
      const extruderId = Number.parseInt(match[1] ?? '', 10)
      if (Number.isInteger(extruderId) && extruderId > 0) extruderIds.add(extruderId)
    }

    // Support filaments are a global process setting, not per-object geometry. Inferring them
    // from the project-wide `enable_support` default would attribute the support material to
    // EVERY object — flooding every plate's "used filaments" with it even when a plate's
    // geometry never triggers support. So we only attribute support filaments to an object that
    // carries its OWN `enable_support` opt-in. (Once a project is sliced, slice_info.config gives
    // the authoritative per-plate filament list and supersedes this estimate entirely.)
    const enableSupport = readModelSettingsMetadataInt(block, 'enable_support')
    if (enableSupport != null && enableSupport > 0) {
      const supportFilamentId = readModelSettingsMetadataInt(block, 'support_filament')
      const supportInterfaceFilamentId = readModelSettingsMetadataInt(block, 'support_interface_filament')
      const supportFilamentIds = [
        supportFilamentId ?? projectSupportConfig.supportFilamentId,
        supportInterfaceFilamentId ?? projectSupportConfig.supportInterfaceFilamentId
      ]
      for (const filamentId of supportFilamentIds) {
        if (filamentId != null && filamentId > 0) extruderIds.add(filamentId)
      }
    }

    if (extruderIds.size > 0) objectExtrudersById.set(objectId, [...extruderIds].sort((left, right) => left - right))
  }
  return objectExtrudersById
}

function parseProjectSupportConfig(projectSettingsJson: string | null): ModelSettingsSupportConfig {
  const empty: ModelSettingsSupportConfig = {
    supportFilamentId: null,
    supportInterfaceFilamentId: null
  }
  if (!projectSettingsJson) return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return empty
  }
  if (!parsed || typeof parsed !== 'object') return empty

  const record = parsed as Record<string, unknown>
  return {
    supportFilamentId: positiveConfigIntValue(record.support_filament),
    supportInterfaceFilamentId: positiveConfigIntValue(record.support_interface_filament)
  }
}

/**
 * The project's support state for the per-plate filament estimate: whether support is enabled
 * project-wide (`enable_support`) and which filaments are dedicated support materials
 * (`filament_is_support`, a parallel `'0'`/`'1'` array of 1-based filament ids). Only dedicated
 * support materials are surfaced across plates — the support-base color is a regular print colour
 * and is left to the geometry to claim.
 */
function parseProjectDedicatedSupport(projectSettingsJson: string | null): { enabled: boolean; filamentIds: number[] } {
  const none = { enabled: false, filamentIds: [] as number[] }
  if (!projectSettingsJson) return none

  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return none
  }
  if (!parsed || typeof parsed !== 'object') return none

  const record = parsed as Record<string, unknown>
  const enabled = (configIntValue(record.enable_support) ?? 0) > 0
  const filamentIds = stringArray(record.filament_is_support)
    .map((flag, index) => (flag === '1' ? index + 1 : null))
    .filter((id): id is number => id != null)
  return { enabled, filamentIds }
}

/** Read an integer `<metadata key="..." value="..."/>` from a model-settings block. Exported for the scene reader. */
export function readModelSettingsMetadataInt(block: string, key: string): number | null {
  const match = new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"\\s*\\/>`).exec(block)
  return match ? parseIntegerValue(match[1] ?? null) : null
}

/** Read a string `<metadata key="..." value="..."/>` from a model-settings block. Exported for the scene reader. */
export function readModelSettingsMetadataString(block: string, key: string): string | null {
  const match = new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"\\s*\\/>`).exec(block)
  return match ? decodeXmlAttributeValue(match[1] ?? '').trim() || null : null
}

function positiveConfigIntValue(value: unknown): number | null {
  const parsed = configIntValue(value)
  return parsed != null && parsed > 0 ? parsed : null
}

function configIntValue(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  return parseIntegerValue(raw)
}

export function parseIntegerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value !== 'string') return null
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isInteger(parsed) ? parsed : null
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry : ''))
}

function numberAt(values: string[], index: number): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) return null
  const parsed = Number(values[index])
  return Number.isFinite(parsed) ? parsed : null
}

/** Parse an XML attribute string into a record. Exported for the scene reader. */
/** Archive entry BambuStudio uses for layer-based custom gcode (filament changes etc.). */
export const CUSTOM_GCODE_PER_LAYER_ENTRY = 'Metadata/custom_gcode_per_layer.xml'

/**
 * Iterate one plate's `<layer .../>` attribute sets from `custom_gcode_per_layer.xml`,
 * in stored order. Shared by the ToolChange and PausePrint parsers below.
 */
function* iterateCustomGcodePlateLayers(text: string | null, plateIndex: number): Generator<Record<string, string>> {
  if (!text) return
  for (const plateMatch of text.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const block = plateMatch[1] ?? ''
    const id = Number.parseInt(parseAttrs(/<plate_info\b([^>]*)\/>/.exec(block)?.[1] ?? '').id ?? '', 10)
    if (id !== plateIndex) continue
    for (const layerMatch of block.matchAll(/<layer\b([^>]*)\/>/g)) {
      yield parseAttrs(layerMatch[1] ?? '')
    }
  }
}

/**
 * Parse one plate's ToolChange entries (type="2") from `custom_gcode_per_layer.xml`:
 * `{ z, filamentId, color }` per change, ordered as stored. Other entry types are
 * intentionally skipped — pauses have their own parser below.
 */
export function parseCustomGcodeToolChanges(
  text: string | null,
  plateIndex: number
): Array<{ z: number; filamentId: number; color: string | null }> {
  const out: Array<{ z: number; filamentId: number; color: string | null }> = []
  for (const attrs of iterateCustomGcodePlateLayers(text, plateIndex)) {
    if (attrs.type !== '2') continue
    const z = Number.parseFloat(attrs.top_z ?? '')
    const filamentId = Number.parseInt(attrs.extruder ?? '', 10)
    if (!Number.isFinite(z) || !Number.isInteger(filamentId) || filamentId <= 0) continue
    out.push({ z, filamentId, color: attrs.color?.trim() || null })
  }
  return out
}

/**
 * Parse one plate's PausePrint entries (type="1") from `custom_gcode_per_layer.xml`:
 * `{ z }` per pause (the paused layer's top_z), ordered as stored.
 */
export function parseCustomGcodePauses(text: string | null, plateIndex: number): Array<{ z: number }> {
  const out: Array<{ z: number }> = []
  for (const attrs of iterateCustomGcodePlateLayers(text, plateIndex)) {
    if (attrs.type !== '1') continue
    const z = Number.parseFloat(attrs.top_z ?? '')
    if (!Number.isFinite(z) || z <= 0) continue
    out.push({ z })
  }
  return out
}

export function parseAttrs(input: string): Record<string, string> {
  const out: Record<string, string> = {}
  // The lookbehind pins each attempt to the start of a name run, keeping the
  // scan linear on malformed input instead of retrying inside long name runs.
  for (const match of input.matchAll(/(?<![\w:-])([\w:-]+)="([^"]*)"/g)) {
    const key = match[1]
    const value = match[2]
    if (key != null && value != null) out[key] = decodeXmlAttributeValue(value)
  }
  return out
}

/** Decode XML/HTML entity escapes in an attribute value. Exported for the scene reader. */
export function decodeXmlAttributeValue(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|apos|quot|amp|lt|gt);/g, (entity, body: string) => {
    switch (body) {
      case 'apos':
        return '\''
      case 'quot':
        return '"'
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      default: {
        const radix = body.startsWith('#x') ? 16 : 10
        const codePoint = Number.parseInt(body.replace(/^#x?/i, ''), radix)
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
      }
    }
  })
}

function numOrNull(value: string | undefined): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Clean up a filament preset name: strip any trailing `@BBL ...` machine
 * qualifier that Bambu Studio appends internally.
 */
function cleanFilamentName(value: string | undefined): string | null {
  if (!value) return null
  // No leading `\s*`: the qualifier match runs to end-of-string, so the final
  // trim removes the same whitespace without the quadratic backtracking.
  const trimmed = value.trim()
    .replace(/@BBL\b.*$/i, '')
    .trim()
  return trimmed || null
}

function normalizePlateType(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized || null
}

function normalizeNozzleDiameter(value: string | null | undefined): string | null {
  if (!value) return null
  const numeric = Number.parseFloat(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return numeric.toString()
}

/** Normalize a colour string to `#RRGGBB` (or null when not a hex colour). Exported for the scene reader. */
export function normalizeColor(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(trimmed)) {
    const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
    return `#${hex.slice(0, 6).toUpperCase()}`
  }
  return null
}
