/**
 * 3MF (Bambu flavor) reader: parse a 3MF archive into typed index/scene structures.
 *
 * The pure index parse (slice-info / model-settings / project-settings → typed index) lives in the
 * shared `@printstream/shared/three-mf` module, which the bridge (`apps/bridge/src/library-3mf.ts`)
 * also consumes — so there is no longer a hand-kept mirror to keep in sync. This module owns the
 * Node-side ZIP I/O + caching for {@link readPlateIndex} and the full scene parse
 * ({@link readSceneManifest}); the latter and all 3MF writing live only in the api modules.
 *
 * A 3MF file is a ZIP. Bambu Studio packs per-plate gcode and PNG thumbnails alongside an XML index
 * at `Metadata/slice_info.config` that lists the plates and the filaments each one uses. This module
 * exposes:
 *  - {@link readPlateIndex} — read the slice-info/model-settings entries and build a typed index.
 *  - {@link readSceneManifest} — parse the plated scene (objects/instances/bed) for the 3D editor.
 *  - {@link readPreviewAssets} — list embedded STL/STEP preview meshes.
 *
 * Results for {@link readPlateIndex} are cached in memory outside development mode (small LRU + TTL).
 * The parser is deliberately tolerant: unknown XML attributes are ignored, and a missing slice-info
 * file falls back to model-settings plate metadata, embedded thumbnails, and finally a synthetic
 * single-plate default so the rest of the UI still works.
 */
import { stat } from 'node:fs/promises'
import {
  MemoryLruCache,
  createAbortError,
  throwIfAborted,
  type BridgeLibraryThreeMfFilament,
  type BridgeLibraryThreeMfIndex,
  type BridgeLibraryThreeMfObject,
  type BridgeLibraryThreeMfPlate,
  type BridgeLibraryThreeMfProjectFilament,
  type PrinterModel
} from '@printstream/shared'
import {
  THREE_MF_INDEX_PARSER_VERSION,
  buildThreeMfIndex,
  collectNormalizedModels,
  decodeXmlAttributeValue,
  extractPlateType,
  firstStringValue,
  normalizeColor,
  normalizePrinterModelName,
  nullableNumberArray,
  parseAttrs,
  parseModelSettingsPlates,
  parseProjectFilaments,
  readModelSettingsMetadataInt,
  readModelSettingsMetadataString,
  stringArray,
  type ModelSettingsPlateMetadata
} from '@printstream/shared/three-mf'
import yauzl, { type Entry } from 'yauzl'
import { env } from './env.js'
import { readEntry } from './three-mf-internal.js'

// Re-export the shared index parser surface that other api modules import from this reader.
export { buildThreeMfIndex, buildDefaultPickFilePath, extractPlateType, normalizeColor, parseAttrs } from '@printstream/shared/three-mf'

// The parsed index types are the shared RPC-contract shapes; alias them under their historical names
// so existing importers (and the scene code below) keep working unchanged.
export type ThreeMfFilament = BridgeLibraryThreeMfFilament
export type ThreeMfPlateObject = BridgeLibraryThreeMfObject
export type ThreeMfPlate = BridgeLibraryThreeMfPlate
export type ThreeMfProjectFilament = BridgeLibraryThreeMfProjectFilament
export type ThreeMfIndex = BridgeLibraryThreeMfIndex

export interface ThreeMfPreviewAsset {
  kind: 'stl' | 'step' | 'stp'
  entryPath: string
}

export interface ThreeMfSceneBed {
  minX: number
  maxX: number
  minY: number
  maxY: number
  plateType: string | null
  /** Unprintable zones (bed coords), as closed polygons, from `bed_exclude_area`. */
  excludeAreas: ThreeMfExcludeZone[]
}

/** An unprintable / single-nozzle zone with an optional Bambu-style label. */
export interface ThreeMfExcludeZone {
  polygon: Array<{ x: number; y: number }>
  label: string | null
}

export interface ThreeMfScenePart {
  entryPath: string
  objectId: number
  transform: number[]
  name: string | null
  sourceFile: string | null
  filamentId: number | null
  filamentName: string | null
  color: string | null
  /** Raw part subtype (support_blocker/support_enforcer/modifier_part/...) or null for a normal part. */
  subtype: string | null
}

export interface ThreeMfSceneInstancePart {
  entryPath: string
  componentObjectId: number
  transform: number[]
  subtype: string | null
}

export interface ThreeMfSceneInstance {
  objectId: number
  instanceId: number
  name: string | null
  /** Plate-local placement (12-element), with the plate-grid origin removed. */
  transform: number[]
  filamentId: number | null
  filamentName: string | null
  color: string | null
  /** BambuStudio "Printable" flag from the build `<item printable>`; omitted when printable. */
  printable?: boolean
  /** Manual brim ears (object-local mm + radius), parsed from brim_ear_points.txt. */
  brimEars?: Array<{ x: number; y: number; z: number; radius: number }>
  parts: ThreeMfSceneInstancePart[]
}

/**
 * Inputs to BambuStudio's prepare-mode wipe-tower footprint estimate. The rendered
 * footprint is derived from these plus the plate's filament count and tallest object
 * (known only once the scene is built), so the actual size is computed on the client.
 */
export interface ThreeMfPrimeTowerSizing {
  wipeVolume: number
  layerHeight: number
  infillGap: number
  ribWall: boolean
  ribWidth: number
  extraRibLength: number
  extruderCount: number
  needWipeTower: boolean
}

/** Prime/wipe tower footprint (plate-local bed coords) when the plate prints one. */
export interface ThreeMfPrimeTower {
  x: number
  y: number
  width: number
  sizing: ThreeMfPrimeTowerSizing
}

export interface ThreeMfScene {
  plateIndex: number
  plateName: string | null
  bed: ThreeMfSceneBed
  parts: ThreeMfScenePart[]
  /** Per-instance grouping with editable plate-local placements (consumed by the 3D editor). */
  instances: ThreeMfSceneInstance[]
  /** Prime tower for this plate, or null when prime tower is disabled. */
  primeTower: ThreeMfPrimeTower | null
  /** Layer-based filament changes for this plate (custom_gcode_per_layer ToolChanges). */
  filamentChanges?: Array<{ z: number; filamentId: number; color: string | null }>
  /** Project filament palette (1-based ids), for rendering colour paint in previews. */
  projectFilaments?: Array<{ id: number; color: string | null }>
}

interface ThreeMfSceneBedPlacement {
  bed: ThreeMfSceneBed
  centerX: number
  centerY: number
  width: number
  depth: number
}

interface CacheEntry {
  mtimeMs: number
  parserVersion: number
  index: ThreeMfIndex
}

export interface ThreeMfRootComponent {
  entryPath: string
  objectId: number
  transform: number[]
}

interface ThreeMfModelSettingsPlateInstance {
  objectId: number
  instanceId: number
}

interface ThreeMfModelSettingsPartMetadata {
  id: number
  name: string | null
  sourceFile: string | null
  extruderId: number | null
  subtype: string | null
}

interface ThreeMfModelSettingsPlateScene {
  index: number
  name: string | null
  instances: ThreeMfModelSettingsPlateInstance[]
  filamentMaps: number[]
}

const IDENTITY_THREE_MF_TRANSFORM = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] as const
export const LOGICAL_PART_PLATE_GAP = 1 / 5
const RAW_SCENE_BED_DIMENSIONS_BY_PRINTER_MODEL: Partial<Record<PrinterModel, { width: number; depth: number }>> = {
  X1C: { width: 256, depth: 256 },
  X1E: { width: 256, depth: 256 },
  P1S: { width: 256, depth: 256 },
  P2S: { width: 256, depth: 256 },
  P1P: { width: 256, depth: 256 },
  A1: { width: 256, depth: 256 },
  A1mini: { width: 180, depth: 180 },
  // Bed sizes from BambuStudio's per-model `printable_area`. The dual-nozzle models also
  // have per-extruder reach below — the bed width MUST match the extruder union or a
  // phantom unreachable strip appears past the last nozzle-only zone.
  X2D: { width: 256, depth: 256 },
  H2D: { width: 350, depth: 320 },
  H2DPRO: { width: 350, depth: 320 },
  H2C: { width: 330, depth: 320 },
  H2S: { width: 340, depth: 320 }
}

/**
 * Per-model unprintable zone (bed coords), used when the 3MF references a machine
 * profile instead of embedding `bed_exclude_area`. Values mirror BambuStudio's
 * machine profiles: the X1/P1 series have an 18x28 mm exclusion in the front-left
 * corner. Other models have no static exclusion (dual-nozzle edges are dynamic).
 */
const BBL_FRONT_LEFT_EXCLUDE_AREA: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 28 }, { x: 0, y: 28 }
]
const BBL_FALLBACK_BED_EXCLUDE_AREA_BY_MODEL: Partial<Record<PrinterModel, ReadonlyArray<{ x: number; y: number }>>> = {
  X1: BBL_FRONT_LEFT_EXCLUDE_AREA,
  X1C: BBL_FRONT_LEFT_EXCLUDE_AREA,
  X1E: BBL_FRONT_LEFT_EXCLUDE_AREA,
  P1S: BBL_FRONT_LEFT_EXCLUDE_AREA,
  P1P: BBL_FRONT_LEFT_EXCLUDE_AREA
}

/**
 * Per-extruder reachable areas (bed coords) for dual-nozzle Bambu machines, used to
 * derive the "Left/Right nozzle only" zones when the 3MF references the machine
 * profile instead of embedding `extruder_printable_area`. Index 0 = left nozzle,
 * index 1 = right nozzle. Mirrors BambuStudio's machine profiles.
 */
const BBL_FALLBACK_EXTRUDER_PRINTABLE_AREA_BY_MODEL: Partial<Record<PrinterModel, ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>>> = {
  H2D: [
    [{ x: 0, y: 0 }, { x: 325, y: 0 }, { x: 325, y: 320 }, { x: 0, y: 320 }],
    [{ x: 25, y: 0 }, { x: 350, y: 0 }, { x: 350, y: 320 }, { x: 25, y: 320 }]
  ],
  H2DPRO: [
    [{ x: 0, y: 0 }, { x: 325, y: 0 }, { x: 325, y: 320 }, { x: 0, y: 320 }],
    [{ x: 25, y: 0 }, { x: 350, y: 0 }, { x: 350, y: 320 }, { x: 25, y: 320 }]
  ],
  // H2C reaches x=325 on the first nozzle and x=330 on the second (narrower than
  // H2D's 350), per BambuStudio's "Bambu Lab H2C 0.4 nozzle" machine profile.
  H2C: [
    [{ x: 0, y: 0 }, { x: 325, y: 0 }, { x: 325, y: 320 }, { x: 0, y: 320 }],
    [{ x: 25, y: 0 }, { x: 330, y: 0 }, { x: 330, y: 320 }, { x: 25, y: 320 }]
  ],
  X2D: [
    [{ x: 0, y: 0 }, { x: 256, y: 0 }, { x: 256, y: 256 }, { x: 0, y: 256 }],
    [{ x: 20.5, y: 0 }, { x: 256, y: 0 }, { x: 256, y: 256 }, { x: 20.5, y: 256 }]
  ]
}

const NOZZLE_ONLY_ZONE_LABELS = ['Left nozzle only area', 'Right nozzle only area']
const NON_RENDERABLE_THREE_MF_PART_SUBTYPES = new Set([
  'negativepart',
  'negativevolume',
  'modifierpart',
  'parametermodifier',
  'supportblocker',
  'supportenforcer'
])

const THREE_MF_PARSER_CACHE_VERSION = THREE_MF_INDEX_PARSER_VERSION
const THREE_MF_PARSER_CACHE_MAX_ENTRIES = 128
const THREE_MF_PARSER_CACHE_TTL_MS = 5 * 60 * 1000
const cache = new MemoryLruCache<string, CacheEntry>({
  maxEntries: THREE_MF_PARSER_CACHE_MAX_ENTRIES,
  ttlMs: THREE_MF_PARSER_CACHE_TTL_MS,
  enabled: env.NODE_ENV !== 'development'
})
export async function readPlateIndex(filePath: string, signal?: AbortSignal): Promise<ThreeMfIndex> {
  throwIfAborted(signal)
  const info = await stat(filePath)
  const cached = cache.get(filePath)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.parserVersion === THREE_MF_PARSER_CACHE_VERSION) return cached.index

  let xml: string | null = null
  try {
    const buffer = await readEntry(filePath, 'Metadata/slice_info.config', signal)
    xml = buffer.toString('utf8')
  } catch {
    xml = null
  }

  let projectSettingsJson: string | null = null
  try {
    const buffer = await readEntry(filePath, 'Metadata/project_settings.config', signal)
    projectSettingsJson = buffer.toString('utf8')
  } catch {
    /* no project settings; fall back to per-plate filament metadata */
  }

  let modelSettingsPlates: ModelSettingsPlateMetadata[] = []
  try {
    const buffer = await readEntry(filePath, 'Metadata/model_settings.config', signal)
    modelSettingsPlates = parseModelSettingsPlates(buffer.toString('utf8'), projectSettingsJson)
  } catch {
    /* no model settings; plates degrade to thumbnails or a synthetic default */
  }

  const thumbnailPlateFiles = await readPlateThumbnailFiles(filePath, signal).catch(() => new Map<number, string>())
  const index = buildThreeMfIndex(xml, projectSettingsJson, modelSettingsPlates, thumbnailPlateFiles)
  cache.set(filePath, { mtimeMs: info.mtimeMs, parserVersion: THREE_MF_PARSER_CACHE_VERSION, index })
  return index
}

export function readPreviewAssets(filePath: string, signal?: AbortSignal): Promise<ThreeMfPreviewAsset[]> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open zip'))
        return
      }

      const assets: ThreeMfPreviewAsset[] = []
      let settled = false
      const onAbort = () => finish(createAbortError('Aborted'))
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        zipFile.close()
        if (error) {
          reject(error)
          return
        }
        assets.sort((left, right) => left.entryPath.localeCompare(right.entryPath))
        resolve(assets)
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      zipFile.on('error', finish)
      zipFile.on('end', () => finish())
      zipFile.on('entry', (entry: Entry) => {
        if (!entry.fileName.endsWith('/')) {
          const lower = entry.fileName.toLowerCase()
          if (lower.endsWith('.stl')) {
            assets.push({ kind: 'stl', entryPath: entry.fileName })
          } else if (lower.endsWith('.step')) {
            assets.push({ kind: 'step', entryPath: entry.fileName })
          } else if (lower.endsWith('.stp')) {
            assets.push({ kind: 'stp', entryPath: entry.fileName })
          }
        }
        zipFile.readEntry()
      })
      zipFile.readEntry()
    })
  })
}

export async function readSceneManifest(
  filePath: string,
  plateIndex: number,
  signal?: AbortSignal,
  overrideModel?: PrinterModel | null
): Promise<ThreeMfScene> {
  throwIfAborted(signal)

  const [rootModelXml, modelSettingsXml, projectSettingsJson, brimEarPointsText, customGcodeText] = await Promise.all([
    readEntry(filePath, '3D/3dmodel.model', signal, 64 * 1024 * 1024).then((buffer) => buffer.toString('utf8')),
    readEntry(filePath, 'Metadata/model_settings.config', signal, 64 * 1024 * 1024).then((buffer) => buffer.toString('utf8')),
    readEntry(filePath, 'Metadata/project_settings.config', signal, 8 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null),
    readEntry(filePath, BRIM_EAR_POINTS_ENTRY, signal, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null),
    readEntry(filePath, CUSTOM_GCODE_PER_LAYER_ENTRY, signal, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null)
  ])

  const rootComponentsByObjectId = parseRootModelComponents(rootModelXml)
  const brimEarsByObjectId = parseBrimEarPoints(brimEarPointsText, rootModelXml)
  const rootBuildTransformsByObjectId = parseRootBuildItemTransforms(rootModelXml)
  const rootBuildPrintableByObjectId = parseRootBuildItemPrintable(rootModelXml)
  const modelSettingsScene = parseModelSettingsScene(modelSettingsXml)
  const plate = modelSettingsScene.plates.find((entry) => entry.index === plateIndex) ?? modelSettingsScene.plates[0] ?? null
  if (!plate) throw new Error('This 3MF does not include any plated scene metadata.')

  const projectFilaments = projectSettingsJson ? parseProjectFilaments(projectSettingsJson) : []
  const projectFilamentsById = new Map(projectFilaments.map((filament) => [filament.id, filament]))
  const plateType = extractPlateType(projectSettingsJson)
  const { bed, width, depth } = extractSceneBed(projectSettingsJson, plateType, overrideModel)
  const plateInstances = resolvePlateInstances(modelSettingsScene.plates, plate.index)
  const plateOrigin = resolveProjectPlateOrigin(plateInstances, rootBuildTransformsByObjectId, bed, width, depth)

  const parts: ThreeMfScenePart[] = []
  const instances: ThreeMfSceneInstance[] = []
  for (const platedInstance of plateInstances) {
    const components = rootComponentsByObjectId.get(platedInstance.objectId) ?? []
    const buildTransforms = rootBuildTransformsByObjectId.get(platedInstance.objectId) ?? []
    const buildTransform = buildTransforms[platedInstance.instanceId] ?? buildTransforms[0] ?? IDENTITY_THREE_MF_TRANSFORM
    const buildPrintable = rootBuildPrintableByObjectId.get(platedInstance.objectId) ?? []
    const printable = buildPrintable[platedInstance.instanceId] ?? buildPrintable[0] ?? true
    const partMetadata = modelSettingsScene.partsByObjectId.get(platedInstance.objectId) ?? new Map<number, ThreeMfModelSettingsPartMetadata>()

    // Plate-local placement: the build-item transform with the plate-grid origin removed, so the
    // editor manipulates objects relative to the plate centre. The inverse (re-adding the origin)
    // is applied by the arrangement writer at slice time.
    const placement = [...buildTransform]
    placement[9] = (placement[9] ?? 0) - plateOrigin.x
    placement[10] = (placement[10] ?? 0) - plateOrigin.y

    const instanceParts: ThreeMfSceneInstancePart[] = []
    let instanceName: string | null = null
    let instanceFilamentId: number | null = null
    let instanceFilament: ThreeMfProjectFilament | null = null
    for (const component of components) {
      const metadata = partMetadata.get(component.objectId) ?? null
      const subtype = metadata?.subtype ?? null
      // Support blockers/enforcers and modifier/negative volumes are rendered (translucently) too,
      // so keep them — but they carry no filament and don't define the instance's name/material.
      const isModifier = isNonRenderableThreeMfPartSubtype(subtype)
      const filamentId = isModifier ? null : mapSceneExtruderToFilamentId(metadata?.extruderId ?? null, plate.filamentMaps)
      const filament = filamentId != null ? projectFilamentsById.get(filamentId) ?? null : null
      const transform = composeThreeMfTransforms(buildTransform, component.transform)
      transform[9] = (transform[9] ?? 0) - plateOrigin.x
      transform[10] = (transform[10] ?? 0) - plateOrigin.y
      parts.push({
        entryPath: component.entryPath,
        objectId: component.objectId,
        transform,
        name: metadata?.name ?? null,
        sourceFile: metadata?.sourceFile ?? null,
        filamentId,
        filamentName: filament?.filamentName ?? null,
        color: filament?.color ?? null,
        subtype
      })
      instanceParts.push({
        entryPath: component.entryPath,
        componentObjectId: component.objectId,
        transform: [...component.transform],
        subtype
      })
      if (isModifier) continue
      if (instanceName == null) instanceName = metadata?.name ?? null
      if (instanceFilamentId == null && filamentId != null) {
        instanceFilamentId = filamentId
        instanceFilament = filament
      }
    }

    if (instanceParts.length > 0) {
      instances.push({
        objectId: platedInstance.objectId,
        instanceId: platedInstance.instanceId,
        name: instanceName,
        transform: placement,
        filamentId: instanceFilamentId,
        filamentName: instanceFilament?.filamentName ?? null,
        color: instanceFilament?.color ?? null,
        // Only carry when skipped; omitted means printable (keeps the scene DTO lean).
        ...(printable ? {} : { printable: false }),
        ...(brimEarsByObjectId.has(platedInstance.objectId)
          ? { brimEars: brimEarsByObjectId.get(platedInstance.objectId)!.map((ear) => ({ ...ear })) }
          : {}),
        parts: instanceParts
      })
    }
  }

  const filamentChanges = parseCustomGcodeToolChanges(customGcodeText, plate.index)
  return {
    plateIndex: plate.index,
    plateName: plate.name,
    bed,
    parts,
    instances,
    primeTower: parsePrimeTower(projectSettingsJson, plate.index),
    ...(filamentChanges.length > 0 ? { filamentChanges } : {}),
    ...(projectFilaments.length > 0
      ? { projectFilaments: projectFilaments.map((filament) => ({ id: filament.id, color: filament.color ?? null })) }
      : {})
  }
}

/**
 * Read the plate's prime/wipe tower footprint from project settings. Returns null
 * when the tower is disabled. Position (`wipe_tower_x`/`_y`) is a per-plate float
 * array in plate-local bed coords; `prime_tower_width` is the footprint size.
 */
function parsePrimeTower(projectSettingsJson: string | null, plateIndex: number): ThreeMfPrimeTower | null {
  if (!projectSettingsJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (!parseConfigBoolean(record.enable_prime_tower)) return null
  const index = Math.max(0, plateIndex - 1)
  const xs = nullableNumberArray(record.wipe_tower_x)
  const ys = nullableNumberArray(record.wipe_tower_y)
  const x = xs[index] ?? xs[0] ?? 15
  const y = ys[index] ?? ys[0] ?? 220
  const width = parseConfigNumber(record.prime_tower_width) ?? 35
  return { x, y, width, sizing: parsePrimeTowerSizing(record) }
}

/**
 * Pull the config inputs BambuStudio's `estimate_wipe_tower_size` consumes. Defaults match
 * BambuStudio's `PrintConfig` so a 3MF that omits a key still sizes like Bambu's prepare view.
 */
function parsePrimeTowerSizing(record: Record<string, unknown>): ThreeMfPrimeTowerSizing {
  // wipe_volume = max of the per-filament prime volumes; "Saving" mode forces every slot to 15.
  const savingMode = isPrimeVolumeSavingMode(record.prime_volume_mode)
  const primeVolumes = nullableNumberArray(record.filament_prime_volume).filter((value): value is number => value != null)
  const wipeVolume = savingMode ? 15 : (primeVolumes.length > 0 ? Math.max(...primeVolumes) : 45)
  const layerHeight = parseConfigNumber(record.layer_height) ?? 0.2
  const infillGap = (parseConfigNumber(record.prime_tower_infill_gap) ?? 150) / 100
  const ribWall = record.prime_tower_rib_wall == null ? true : parseConfigBoolean(record.prime_tower_rib_wall)
  const ribWidth = parseConfigNumber(record.prime_tower_rib_width) ?? 8
  const extraRibLength = parseConfigNumber(record.prime_tower_extra_rib_length) ?? 0
  // Number of physical extruders: nozzle_diameter is one entry per nozzle (2 ⇒ dual-nozzle).
  const extruderCount = Math.max(1, nullableNumberArray(record.nozzle_diameter).length || 1)
  const wrapping = parseConfigBoolean(record.enable_wrapping_detection)
  const timelapse = typeof record.timelapse_type === 'string' ? record.timelapse_type.toLowerCase() : null
  const needWipeTower = wrapping || timelapse === 'smooth'
  return { wipeVolume, layerHeight, infillGap, ribWall, ribWidth, extraRibLength, extruderCount, needWipeTower }
}

/** BambuStudio's `prime_volume_mode` enum: "Saving" (or its index 1) halves purge to a flat 15. */
function isPrimeVolumeSavingMode(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().toLowerCase() === 'saving' || value.trim() === '1'
  if (typeof value === 'number') return value === 1
  if (Array.isArray(value)) return isPrimeVolumeSavingMode(value[0])
  return false
}

/** Parse a Bambu config boolean which may be a real boolean or a "0"/"1" string. */
function parseConfigBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true'
  if (Array.isArray(value)) return parseConfigBoolean(value[0])
  return false
}

/** Parse a Bambu config number which may be a number or numeric string (or [string]). */
function parseConfigNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (Array.isArray(value)) return parseConfigNumber(value[0])
  return null
}

function readPlateThumbnailFiles(filePath: string, signal?: AbortSignal): Promise<Map<number, string>> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open zip'))
        return
      }
      const thumbnails = new Map<number, string>()
      let resolved = false
      const onAbort = () => finish(createAbortError('Aborted'))
      const finish = (error?: Error) => {
        if (resolved) return
        resolved = true
        signal?.removeEventListener('abort', onAbort)
        zipFile.close()
        if (error) reject(error)
        else resolve(new Map([...thumbnails].sort(([left], [right]) => left - right)))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      zipFile.on('error', finish)
      zipFile.on('end', () => finish())
      zipFile.on('entry', (entry: Entry) => {
        const match = /^Metadata\/plate_(\d+)\.png$/i.exec(entry.fileName)
        const plateIndex = Number(match?.[1])
        if (Number.isInteger(plateIndex) && plateIndex > 0) thumbnails.set(plateIndex, entry.fileName)
        zipFile.readEntry()
      })
      zipFile.readEntry()
    })
  })
}

/**
 * Resolve each root object's geometry components: `(root objectId) -> [{ entryPath,
 * objectId (component/mesh id within that entry), transform }]`. Objects with an inline
 * mesh resolve to a single self-referential component on the root model entry. Also used
 * by the scene builder to locate the mesh entry a painted part lives in.
 */
export function parseRootModelComponents(xml: string): Map<number, ThreeMfRootComponent[]> {
  const out = new Map<number, ThreeMfRootComponent[]>()
  const objectBlocks = xml.match(/<object\b[^>]*>[\s\S]*?<\/object>/g) ?? []
  for (const block of objectBlocks) {
    const objectAttrs = parseAttrs(block.match(/^<object\b([^>]*)>/)?.[1] ?? '')
    const rootObjectId = Number.parseInt(objectAttrs.id ?? '', 10)
    if (!Number.isInteger(rootObjectId) || rootObjectId <= 0) continue

    const components: ThreeMfRootComponent[] = []
    for (const match of block.matchAll(/<component\b([^>]*)\/>/g)) {
      const attrs = parseAttrs(match[1] ?? '')
      // No p:path means a same-file component (generic 3MF assemblies, and the part
      // volumes the editor adds): the referenced object lives in the root model entry.
      const entryPath = (attrs['p:path'] ?? attrs.path ?? '').replace(/^\/+/, '') || '3D/3dmodel.model'
      const objectId = Number.parseInt(attrs.objectid ?? '', 10)
      const transform = parseThreeMfTransform(attrs.transform)
      if (!Number.isInteger(objectId) || objectId <= 0 || !transform) continue
      components.push({ entryPath, objectId, transform })
    }

    // Objects that carry their mesh inline (no sub-model components) — including the imported meshes
    // the editor injects — are treated as a single self-referential component so the scene reader and
    // the web geometry loader pick them up from the root model entry.
    if (components.length === 0 && /<mesh\b/.test(block)) {
      components.push({ entryPath: '3D/3dmodel.model', objectId: rootObjectId, transform: [...IDENTITY_THREE_MF_TRANSFORM] })
    }

    if (components.length > 0) out.set(rootObjectId, components)
  }
  return out
}

/** Archive entry BambuStudio uses for layer-based custom gcode (filament changes etc.). */
export const CUSTOM_GCODE_PER_LAYER_ENTRY = 'Metadata/custom_gcode_per_layer.xml'

/**
 * Parse one plate's ToolChange entries (type="2") from `custom_gcode_per_layer.xml`:
 * `{ z, filamentId, color }` per change, ordered as stored. Pause/custom entries are
 * intentionally skipped — the editor only authors filament changes.
 */
export function parseCustomGcodeToolChanges(
  text: string | null,
  plateIndex: number
): Array<{ z: number; filamentId: number; color: string | null }> {
  if (!text) return []
  const out: Array<{ z: number; filamentId: number; color: string | null }> = []
  for (const plateMatch of text.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const block = plateMatch[1] ?? ''
    const id = Number.parseInt(parseAttrs(/<plate_info\b([^>]*)\/>/.exec(block)?.[1] ?? '').id ?? '', 10)
    if (id !== plateIndex) continue
    for (const layerMatch of block.matchAll(/<layer\b([^>]*)\/>/g)) {
      const attrs = parseAttrs(layerMatch[1] ?? '')
      if (attrs.type !== '2') continue
      const z = Number.parseFloat(attrs.top_z ?? '')
      const filamentId = Number.parseInt(attrs.extruder ?? '', 10)
      if (!Number.isFinite(z) || !Number.isInteger(filamentId) || filamentId <= 0) continue
      out.push({ z, filamentId, color: attrs.color?.trim() || null })
    }
  }
  return out
}

/** Archive entry BambuStudio/Orca use for manual brim ears. */
export const BRIM_EAR_POINTS_ENTRY = 'Metadata/brim_ear_points.txt'

/**
 * Root model object ids in document order. BambuStudio's importer creates one
 * ModelObject per root `<object>` resource in this order, and several sidecar files
 * (brim ears, layer-height profiles) reference objects by that 1-based ordinal.
 */
export function parseRootModelObjectIdOrder(xml: string): number[] {
  const ids: number[] = []
  for (const match of xml.matchAll(/<object\b([^>]*)>/g)) {
    const id = Number.parseInt(parseAttrs(match[1] ?? '').id ?? '', 10)
    if (Number.isInteger(id) && id > 0) ids.push(id)
  }
  return ids
}

/**
 * Parse `Metadata/brim_ear_points.txt` ("object_id=<1-based ordinal>|x y z r ..." per
 * line, optional version header) into a map keyed by the ROOT 3MF object id.
 */
export function parseBrimEarPoints(
  text: string | null,
  rootModelXml: string
): Map<number, Array<{ x: number; y: number; z: number; radius: number }>> {
  const out = new Map<number, Array<{ x: number; y: number; z: number; radius: number }>>()
  if (!text) return out
  const orderedObjectIds = parseRootModelObjectIdOrder(rootModelXml)
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines[0]?.startsWith('brim_points_format_version=')) lines.shift()
  for (const line of lines) {
    const match = /^object_id=(\d+)\|(.*)$/.exec(line)
    if (!match) continue
    const ordinal = Number.parseInt(match[1] ?? '', 10)
    const objectId = orderedObjectIds[ordinal - 1]
    if (!objectId) continue
    const values = (match[2] ?? '').split(/\s+/).map((value) => Number.parseFloat(value))
    const points: Array<{ x: number; y: number; z: number; radius: number }> = []
    for (let i = 0; i + 3 < values.length; i += 4) {
      const [x, y, z, radius] = [values[i]!, values[i + 1]!, values[i + 2]!, values[i + 3]!]
      if ([x, y, z, radius].every((value) => Number.isFinite(value))) points.push({ x, y, z, radius })
    }
    if (points.length > 0) out.set(objectId, points)
  }
  return out
}

function parseRootBuildItemTransforms(xml: string): Map<number, number[][]> {
  const out = new Map<number, number[][]>()
  const buildBlock = xml.match(/<build\b[^>]*>[\s\S]*?<\/build>/)?.[0] ?? ''
  for (const match of buildBlock.matchAll(/<item\b([^>]*)\/?>(?:<\/item>)?/g)) {
    const attrs = parseAttrs(match[1] ?? '')
    const objectId = Number.parseInt(attrs.objectid ?? '', 10)
    if (!Number.isInteger(objectId) || objectId <= 0) continue
    const transform = parseThreeMfTransform(attrs.transform) ?? [...IDENTITY_THREE_MF_TRANSFORM]
    const entries = out.get(objectId) ?? []
    entries.push(transform)
    out.set(objectId, entries)
  }
  return out
}

/**
 * Per-object, per-occurrence `printable` flags from the root build `<item>`s, in the same
 * order as {@link parseRootBuildItemTransforms} so they index by `instanceId`. `printable="0"`
 * is BambuStudio's "Printable" toggle (greyed, excluded from slice); any other/absent value
 * means printable.
 */
function parseRootBuildItemPrintable(xml: string): Map<number, boolean[]> {
  const out = new Map<number, boolean[]>()
  const buildBlock = xml.match(/<build\b[^>]*>[\s\S]*?<\/build>/)?.[0] ?? ''
  for (const match of buildBlock.matchAll(/<item\b([^>]*)\/?>(?:<\/item>)?/g)) {
    const attrs = parseAttrs(match[1] ?? '')
    const objectId = Number.parseInt(attrs.objectid ?? '', 10)
    if (!Number.isInteger(objectId) || objectId <= 0) continue
    const entries = out.get(objectId) ?? []
    entries.push(attrs.printable !== '0')
    out.set(objectId, entries)
  }
  return out
}

export function parseModelSettingsScene(xml: string): {
  plates: ThreeMfModelSettingsPlateScene[]
  partsByObjectId: Map<number, Map<number, ThreeMfModelSettingsPartMetadata>>
} {
  const plates: ThreeMfModelSettingsPlateScene[] = []
  const partsByObjectId = new Map<number, Map<number, ThreeMfModelSettingsPartMetadata>>()

  const objectBlocks = xml.match(/<object\b[^>]*>[\s\S]*?<\/object>/g) ?? []
  for (const block of objectBlocks) {
    const objectAttrs = parseAttrs(block.match(/^<object\b([^>]*)>/)?.[1] ?? '')
    const objectId = Number.parseInt(objectAttrs.id ?? '', 10)
    if (!Number.isInteger(objectId) || objectId <= 0) continue

    const objectName = readModelSettingsMetadataString(block, 'name')
    const objectExtruderId = readModelSettingsMetadataInt(block, 'extruder')
    const partMap = new Map<number, ThreeMfModelSettingsPartMetadata>()
    for (const match of block.matchAll(/<part\b([^>]*)>[\s\S]*?<\/part>/g)) {
      const partBlock = match[0]
      const partAttrs = parseAttrs(match[1] ?? '')
      const partId = Number.parseInt(partAttrs.id ?? '', 10)
      if (!Number.isInteger(partId) || partId <= 0) continue
      partMap.set(partId, {
        id: partId,
        name: readModelSettingsMetadataString(partBlock, 'name') ?? objectName,
        sourceFile: readModelSettingsMetadataString(partBlock, 'source_file'),
        extruderId: readModelSettingsMetadataInt(partBlock, 'extruder') ?? objectExtruderId,
        subtype: readThreeMfPartSubtype(partBlock, partAttrs)
      })
    }
    if (partMap.size > 0) partsByObjectId.set(objectId, partMap)
  }

  const plateBlocks = xml.match(/<plate\b[^>]*>[\s\S]*?<\/plate>/g) ?? []
  for (const block of plateBlocks) {
    const meta = new Map<string, string>()
    for (const match of block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
      const key = match[1]
      const value = match[2]
      if (key != null && value != null) meta.set(key, decodeXmlAttributeValue(value))
    }
    const index = Number.parseInt(meta.get('plater_id') ?? '', 10)
    if (!Number.isInteger(index) || index <= 0) continue
    const instances = Array.from(block.matchAll(/<model_instance\b[^>]*>([\s\S]*?)<\/model_instance>/g), (match) => {
      const modelInstanceBlock = match[1] ?? ''
      const objectId = Number.parseInt(readModelSettingsMetadataString(modelInstanceBlock, 'object_id') ?? '', 10)
      const instanceId = Number.parseInt(readModelSettingsMetadataString(modelInstanceBlock, 'instance_id') ?? '0', 10)
      return {
        objectId,
        instanceId: Number.isInteger(instanceId) && instanceId >= 0 ? instanceId : 0
      }
    }).filter((entry) => Number.isInteger(entry.objectId) && entry.objectId > 0)
    plates.push({
      index,
      name: meta.get('plater_name')?.trim() || null,
      instances,
      filamentMaps: parseSceneFilamentMaps(meta.get('filament_maps'))
    })
  }

  plates.sort((left, right) => left.index - right.index)
  return { plates, partsByObjectId }
}

export function extractSceneBed(
  projectSettingsJson: string | null,
  plateType: string | null,
  overrideModel?: PrinterModel | null
): ThreeMfSceneBedPlacement {
  const fallback = createSceneBedPlacement(-128, 128, -128, 128, plateType)
  // When the user has chosen a target printer in the slice dialog, show that
  // printer's bed + unprintable zones instead of the file's embedded machine.
  if (overrideModel) {
    const overrideBed = bedPlacementForPrinterModel(overrideModel, plateType)
    if (overrideBed) return overrideBed
  }
  if (!projectSettingsJson) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return fallback
  }
  if (!parsed || typeof parsed !== 'object') return fallback

  const record = parsed as Record<string, unknown>
  const fallbackModel = extractSceneFallbackPrinterModel(record)

  // Unprintable corner zone (bed_exclude_area), with the per-model fallback.
  const excludeAreas: ThreeMfExcludeZone[] = parseBedExcludeAreas(record.bed_exclude_area)
    .map((polygon) => ({ polygon, label: null }))
  if (excludeAreas.length === 0 && fallbackModel) {
    const fallbackArea = BBL_FALLBACK_BED_EXCLUDE_AREA_BY_MODEL[fallbackModel]
    if (fallbackArea) excludeAreas.push({ polygon: fallbackArea.map((point) => ({ ...point })), label: null })
  }

  // Per-extruder reachable areas — used for the bed extent and the "nozzle only" zones.
  let extruderAreas = parseExtruderPrintableAreas(record.extruder_printable_area)
  if (extruderAreas.length === 0 && fallbackModel) {
    const fallbackAreas = BBL_FALLBACK_EXTRUDER_PRINTABLE_AREA_BY_MODEL[fallbackModel]
    if (fallbackAreas) extruderAreas = fallbackAreas.map((polygon) => polygon.map((point) => ({ ...point })))
  }
  excludeAreas.push(...computeNozzleOnlyZones(extruderAreas))

  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const polygon of extruderAreas) {
    for (const point of polygon) {
      minX = Math.min(minX, point.x)
      maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y)
      maxY = Math.max(maxY, point.y)
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    const rawDimensions = fallbackModel ? RAW_SCENE_BED_DIMENSIONS_BY_PRINTER_MODEL[fallbackModel] : null
    if (rawDimensions) {
      return createSceneBedPlacement(0, rawDimensions.width, 0, rawDimensions.depth, plateType, excludeAreas)
    }
    return createSceneBedPlacement(-128, 128, -128, 128, plateType, excludeAreas)
  }

  return createSceneBedPlacement(minX, maxX, minY, maxY, plateType, excludeAreas)
}

/**
 * Parse Bambu/Orca `bed_exclude_area` into closed polygons of bed-coordinate points.
 * Each array entry may be a single `"<x>x<y>"` point or a comma-joined list of them.
 */
function parseBedExcludeAreas(value: unknown): Array<Array<{ x: number; y: number }>> {
  const points: Array<{ x: number; y: number }> = []
  for (const entry of stringArray(value)) {
    for (const point of entry.split(',')) {
      const match = /^\s*(-?\d+(?:\.\d+)?)x(-?\d+(?:\.\d+)?)\s*$/i.exec(point)
      if (!match) continue
      const x = Number.parseFloat(match[1] ?? '')
      const y = Number.parseFloat(match[2] ?? '')
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y })
    }
  }
  // Reject placeholder/zero-area polygons (e.g. ["0x0","0x0",...]) so the per-model
  // fallback can apply instead of a non-rendering degenerate zone.
  return points.length >= 3 && polygonArea(points) >= 1 ? [points] : []
}

/** Absolute shoelace area of a polygon. */
function polygonArea(points: Array<{ x: number; y: number }>): number {
  let area = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    if (a && b) area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area) / 2
}

/** Parse `extruder_printable_area` (one comma-joined polygon string per extruder). */
function parseExtruderPrintableAreas(value: unknown): Array<Array<{ x: number; y: number }>> {
  const polygons: Array<Array<{ x: number; y: number }>> = []
  for (const entry of stringArray(value)) {
    const points: Array<{ x: number; y: number }> = []
    for (const point of entry.split(',')) {
      const match = /^\s*(-?\d+(?:\.\d+)?)x(-?\d+(?:\.\d+)?)\s*$/i.exec(point)
      if (!match) continue
      const x = Number.parseFloat(match[1] ?? '')
      const y = Number.parseFloat(match[2] ?? '')
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y })
    }
    if (points.length >= 3) polygons.push(points)
  }
  return polygons
}

/**
 * Derive the "Left/Right nozzle only" zones for a dual-nozzle machine: the parts of
 * each extruder's (axis-aligned) reachable rectangle that the other extruder cannot
 * reach. Only the two-extruder case is handled (the Bambu dual-nozzle layout).
 */
function computeNozzleOnlyZones(extruderAreas: Array<Array<{ x: number; y: number }>>): ThreeMfExcludeZone[] {
  if (extruderAreas.length !== 2) return []
  const boxes = extruderAreas.map((polygon) => {
    const xs = polygon.map((point) => point.x)
    const ys = polygon.map((point) => point.y)
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
  })
  const zones: ThreeMfExcludeZone[] = []
  for (let i = 0; i < 2; i += 1) {
    const self = boxes[i]
    const other = boxes[1 - i]
    if (!self || !other) continue
    const strips: Array<{ x0: number; x1: number }> = []
    if (self.minX < other.minX) strips.push({ x0: self.minX, x1: Math.min(self.maxX, other.minX) })
    if (self.maxX > other.maxX) strips.push({ x0: Math.max(self.minX, other.maxX), x1: self.maxX })
    for (const strip of strips) {
      if (strip.x1 - strip.x0 < 0.5) continue
      zones.push({
        polygon: [
          { x: strip.x0, y: self.minY },
          { x: strip.x1, y: self.minY },
          { x: strip.x1, y: self.maxY },
          { x: strip.x0, y: self.maxY }
        ],
        label: NOZZLE_ONLY_ZONE_LABELS[i] ?? null
      })
    }
  }
  return zones
}

/**
 * Build a bed placement for a specific printer model from the per-model tables
 * (dimensions, X1/P1 corner exclusion, and dual-nozzle "nozzle only" zones). Used
 * when the slice dialog targets a printer different from the file's embedded one.
 * Returns null for models without known dimensions.
 */
function bedPlacementForPrinterModel(model: PrinterModel, plateType: string | null): ThreeMfSceneBedPlacement | null {
  const dimensions = RAW_SCENE_BED_DIMENSIONS_BY_PRINTER_MODEL[model]
  if (!dimensions) return null
  const excludeAreas: ThreeMfExcludeZone[] = []
  const corner = BBL_FALLBACK_BED_EXCLUDE_AREA_BY_MODEL[model]
  if (corner) excludeAreas.push({ polygon: corner.map((point) => ({ ...point })), label: null })
  const extruders = BBL_FALLBACK_EXTRUDER_PRINTABLE_AREA_BY_MODEL[model]
  if (extruders) excludeAreas.push(...computeNozzleOnlyZones(extruders.map((polygon) => polygon.map((point) => ({ ...point })))))
  return createSceneBedPlacement(0, dimensions.width, 0, dimensions.depth, plateType, excludeAreas)
}

function createSceneBedPlacement(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  plateType: string | null,
  excludeAreas: ThreeMfExcludeZone[] = []
): ThreeMfSceneBedPlacement {
  return {
    bed: {
      minX,
      maxX,
      minY,
      maxY,
      plateType,
      excludeAreas
    },
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: maxX - minX,
    depth: maxY - minY
  }
}

function extractSceneFallbackPrinterModel(record: Record<string, unknown>): PrinterModel | null {
  const models = new Set<PrinterModel>()
  collectNormalizedModels(record.printer_model, models)
  collectNormalizedModels(record.printer_settings_id, models)
  collectNormalizedModels(record.compatible_printers, models)
  collectNormalizedModels(record.print_compatible_printers, models)
  collectNormalizedModels(record.models, models)
  if (models.size > 0) return models.values().next().value ?? null

  const machineStartGcode = firstStringValue(record.machine_start_gcode)
  const machineMatch = machineStartGcode ? /machine:\s*([^\s=]+)/i.exec(machineStartGcode) : null
  return normalizePrinterModelName(machineMatch?.[1])
}

function resolvePlateInstances(
  plates: ThreeMfModelSettingsPlateScene[],
  targetPlateIndex: number
): ThreeMfModelSettingsPlateInstance[] {
  const plateIndex = plates.findIndex((entry) => entry.index === targetPlateIndex)
  if (plateIndex <= 0) return plates[plateIndex]?.instances ?? plates[0]?.instances ?? []

  const previousKeys = new Set((plates[plateIndex - 1]?.instances ?? []).map((entry) => `${entry.objectId}:${entry.instanceId}`))
  const current = plates[plateIndex]?.instances ?? []
  const delta = current.filter((entry) => !previousKeys.has(`${entry.objectId}:${entry.instanceId}`))
  return delta.length > 0 ? delta : current
}

function resolveProjectPlateOrigin(
  instances: ThreeMfModelSettingsPlateInstance[],
  buildTransformsByObjectId: Map<number, number[][]>,
  bed: ThreeMfSceneBed,
  plateWidth: number,
  plateDepth: number
): { x: number; y: number } {
  const strideX = plateWidth * (1 + LOGICAL_PART_PLATE_GAP)
  const strideY = plateDepth * (1 + LOGICAL_PART_PLATE_GAP)
  const placements = instances.map((instance) => {
    const buildTransforms = buildTransformsByObjectId.get(instance.objectId) ?? []
    const buildTransform = buildTransforms[instance.instanceId] ?? buildTransforms[0] ?? IDENTITY_THREE_MF_TRANSFORM
    return {
      x: buildTransform[9] ?? 0,
      y: buildTransform[10] ?? 0
    }
  })

  const maxColumn = Math.max(0, ...placements.map((placement) => Math.ceil((placement.x - bed.minX) / strideX)))
  const maxRow = Math.max(0, ...placements.map((placement) => Math.ceil((bed.maxY - placement.y) / strideY)))

  let originX = 0
  for (let col = 0; col <= maxColumn; col += 1) {
    const candidateX = col * strideX
    if (placements.every((placement) => placement.x - candidateX >= bed.minX - 1e-3 && placement.x - candidateX <= bed.maxX + 1e-3)) {
      originX = candidateX
      break
    }
  }

  let originY = 0
  for (let row = 0; row <= maxRow; row += 1) {
    const candidateY = -row * strideY
    if (placements.every((placement) => placement.y - candidateY >= bed.minY - 1e-3 && placement.y - candidateY <= bed.maxY + 1e-3)) {
      originY = candidateY
      break
    }
  }

  return { x: originX, y: originY }
}

function mapSceneExtruderToFilamentId(extruderId: number | null, filamentMaps: number[]): number | null {
  if (extruderId == null || !Number.isInteger(extruderId) || extruderId <= 0) return null
  if (!hasOneToOneSceneFilamentMap(filamentMaps)) return extruderId
  const mapped = filamentMaps[extruderId - 1]
  if (typeof mapped === 'number' && Number.isInteger(mapped) && mapped > 0) return mapped
  return extruderId
}

function hasOneToOneSceneFilamentMap(filamentMaps: number[]): boolean {
  const normalized = filamentMaps.filter((entry) => Number.isInteger(entry) && entry > 0)
  if (normalized.length === 0) return false
  return new Set(normalized).size === normalized.length
}

function parseSceneFilamentMaps(value: string | undefined): number[] {
  if (!value) return []
  return value
    .trim()
    .split(/\s+/)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isInteger(entry) && entry >= 0)
}

function parseThreeMfTransform(value: string | undefined): number[] | null {
  if (!value) return null
  const numbers = value
    .trim()
    .split(/\s+/)
    .map((entry) => Number.parseFloat(entry))
  return numbers.length === 12 && numbers.every((entry) => Number.isFinite(entry))
    ? numbers
    : null
}

function composeThreeMfTransforms(parent: readonly number[], child: readonly number[]): number[] {
  const a00 = parent[0] ?? 1
  const a10 = parent[1] ?? 0
  const a20 = parent[2] ?? 0
  const a01 = parent[3] ?? 0
  const a11 = parent[4] ?? 1
  const a21 = parent[5] ?? 0
  const a02 = parent[6] ?? 0
  const a12 = parent[7] ?? 0
  const a22 = parent[8] ?? 1
  const atx = parent[9] ?? 0
  const aty = parent[10] ?? 0
  const atz = parent[11] ?? 0

  const b00 = child[0] ?? 1
  const b10 = child[1] ?? 0
  const b20 = child[2] ?? 0
  const b01 = child[3] ?? 0
  const b11 = child[4] ?? 1
  const b21 = child[5] ?? 0
  const b02 = child[6] ?? 0
  const b12 = child[7] ?? 0
  const b22 = child[8] ?? 1
  const btx = child[9] ?? 0
  const bty = child[10] ?? 0
  const btz = child[11] ?? 0

  return [
    a00 * b00 + a01 * b10 + a02 * b20,
    a10 * b00 + a11 * b10 + a12 * b20,
    a20 * b00 + a21 * b10 + a22 * b20,
    a00 * b01 + a01 * b11 + a02 * b21,
    a10 * b01 + a11 * b11 + a12 * b21,
    a20 * b01 + a21 * b11 + a22 * b21,
    a00 * b02 + a01 * b12 + a02 * b22,
    a10 * b02 + a11 * b12 + a12 * b22,
    a20 * b02 + a21 * b12 + a22 * b22,
    a00 * btx + a01 * bty + a02 * btz + atx,
    a10 * btx + a11 * bty + a12 * btz + aty,
    a20 * btx + a21 * bty + a22 * btz + atz
  ]
}

function readThreeMfPartSubtype(partBlock: string, partAttrs: Record<string, string>): string | null {
  return partAttrs.subtype?.trim() || readModelSettingsMetadataString(partBlock, 'volume_type') || null
}

function isNonRenderableThreeMfPartSubtype(subtype: string | null): boolean {
  if (!subtype) return false
  return NON_RENDERABLE_THREE_MF_PART_SUBTYPES.has(normalizeThreeMfPartSubtype(subtype))
}

function normalizeThreeMfPartSubtype(subtype: string): string {
  return subtype.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}
