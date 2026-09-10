/**
 * 3MF (Bambu flavor) reader: parse a 3MF archive into typed index/scene structures.
 *
 * Both pure parses live in the shared `@printstream/shared/three-mf` module: the index parse
 * (`buildThreeMfIndex`, also consumed by the bridge in `apps/bridge/src/library-3mf.ts`) and the
 * scene parse (`buildSceneManifest`, also consumed by the web's client-side public 3MF editor).
 * This module owns only the Node-side ZIP I/O and caching around them, so there is no hand-kept
 * mirror to drift. All 3MF *writing* still lives only in the api modules.
 *
 * A 3MF file is a ZIP. Bambu Studio packs per-plate gcode and PNG thumbnails alongside an XML index
 * at `Metadata/slice_info.config` that lists the plates and the filaments each one uses. This module
 * exposes:
 *  - {@link readPlateIndex}: read the slice-info/model-settings entries and build a typed index.
 *  - {@link readSceneManifest}: parse the plated scene (objects/instances/bed) for the 3D editor.
 *  - {@link readPreviewAssets}: list embedded STL/STEP preview meshes.
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
  BRIM_EAR_POINTS_ENTRY,
  CUT_INFORMATION_ENTRY,
  CUSTOM_GCODE_PER_LAYER_ENTRY,
  FILAMENT_SEQUENCE_ENTRY,
  THREE_MF_INDEX_PARSER_VERSION,
  buildSceneManifest,
  buildThreeMfIndex,
  parseModelSettingsPlates,
  type ModelSettingsPlateMetadata,
  type ThreeMfScene,
  LAYER_CONFIG_RANGES_ENTRY,
  LAYER_HEIGHTS_PROFILE_ENTRY
} from '@printstream/shared/three-mf'
import yauzl, { type Entry } from 'yauzl'
import { env } from './env.js'
import { readEntry } from './three-mf-internal.js'

// Re-export the shared index+scene parser surface that other api modules import from this reader,
// so moving those parses into `@printstream/shared/three-mf` did not churn every call site.
export {
  BRIM_EAR_POINTS_ENTRY,
  CUT_INFORMATION_ENTRY,
  CUSTOM_GCODE_PER_LAYER_ENTRY,
  FILAMENT_SEQUENCE_ENTRY,
  LOGICAL_PART_PLATE_GAP,
  buildDefaultPickFilePath,
  buildSceneManifest,
  buildThreeMfIndex,
  composeThreeMfTransforms,
  extractPlateType,
  extractSceneBed,
  normalizeColor,
  parseAttrs,
  parseBrimEarPoints,
  parseCustomGcodePauses,
  parseCustomGcodeToolChanges,
  parseModelSettingsScene,
  parseRootBuildItemTransforms,
  parseRootModelComponents,
  parseRootModelObjectIdOrder,
  type ThreeMfExcludeZone,
  type ThreeMfPrimeTower,
  type ThreeMfPrimeTowerSizing,
  type ThreeMfRootComponent,
  type ThreeMfScene,
  type ThreeMfSceneBed,
  type ThreeMfSceneEntries,
  type ThreeMfSceneInstance,
  type ThreeMfSceneInstancePart,
  type ThreeMfScenePart
} from '@printstream/shared/three-mf'

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

interface CacheEntry {
  mtimeMs: number
  parserVersion: number
  index: ThreeMfIndex
}

const THREE_MF_PARSER_CACHE_VERSION = THREE_MF_INDEX_PARSER_VERSION
const THREE_MF_PARSER_CACHE_MAX_ENTRIES = 128
const THREE_MF_PARSER_CACHE_TTL_MS = 5 * 60 * 1000
const cache = new MemoryLruCache<string, CacheEntry>({
  maxEntries: THREE_MF_PARSER_CACHE_MAX_ENTRIES,
  ttlMs: THREE_MF_PARSER_CACHE_TTL_MS,
  enabled: env.NODE_ENV !== 'development'
})

// Scene manifests are re-requested per plate (one /scene per plate on open) and again whenever the
// slice target printer changes (overrideModel is in the key). Each call re-decodes + re-parses the
// full root model XML, so without a cache opening an N-plate project is O(N x full-parse) and a
// printer switch re-pays it. Cache the parsed scene keyed by file+plate+overrideModel, invalidated
// by mtime + parser version exactly like the index cache above.
interface SceneCacheEntry {
  mtimeMs: number
  parserVersion: number
  scene: ThreeMfScene
}
const sceneCache = new MemoryLruCache<string, SceneCacheEntry>({
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
  // Raw document kept beside the parsed plates: the repair inspection reads object-level
  // extruder bindings, which the plate metadata does not carry.
  let modelSettingsXml: string | null = null
  try {
    const buffer = await readEntry(filePath, 'Metadata/model_settings.config', signal)
    modelSettingsXml = buffer.toString('utf8')
    modelSettingsPlates = parseModelSettingsPlates(modelSettingsXml, projectSettingsJson)
  } catch {
    /* no model settings; plates degrade to thumbnails or a synthetic default */
  }

  const thumbnailPlateFiles = await readPlateThumbnailFiles(filePath, signal).catch(() => new Map<number, string>())
  // Layer G-code sidecar (filament changes / pauses): optional; most projects have none.
  const customGcodeXml = await readEntry(filePath, CUSTOM_GCODE_PER_LAYER_ENTRY, signal)
    .then((buffer) => buffer.toString('utf8'))
    .catch(() => null)
  // Slicer filament grouping (FTS arrangement hint): only a sliced project has one.
  const filamentSequenceJson = await readEntry(filePath, FILAMENT_SEQUENCE_ENTRY, signal)
    .then((buffer) => buffer.toString('utf8'))
    .catch(() => null)
  const index = buildThreeMfIndex(
    xml,
    projectSettingsJson,
    modelSettingsPlates,
    thumbnailPlateFiles,
    customGcodeXml,
    modelSettingsXml,
    { filamentSequenceJson }
  )
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

  const info = await stat(filePath)
  const sceneCacheKey = `${filePath}:${plateIndex}:${overrideModel ?? ''}`
  const cachedScene = sceneCache.get(sceneCacheKey)
  if (cachedScene && cachedScene.mtimeMs === info.mtimeMs && cachedScene.parserVersion === THREE_MF_PARSER_CACHE_VERSION) {
    return cachedScene.scene
  }

  const [rootModelXml, modelSettingsXml, projectSettingsJson, brimEarPointsText, layerConfigRangesXml, layerHeightsProfileText, customGcodeText, cutInformationXml] = await Promise.all([
    readEntry(filePath, '3D/3dmodel.model', signal, 64 * 1024 * 1024).then((buffer) => buffer.toString('utf8')),
    // Default 8 MiB cap: matches the bridge's bound for the same entry; only the
    // mesh XML above legitimately outgrows it.
    readEntry(filePath, 'Metadata/model_settings.config', signal).then((buffer) => buffer.toString('utf8')),
    readEntry(filePath, 'Metadata/project_settings.config', signal, 8 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null),
    readEntry(filePath, BRIM_EAR_POINTS_ENTRY, signal, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null),
    readEntry(filePath, LAYER_CONFIG_RANGES_ENTRY, signal, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null),
    readEntry(filePath, LAYER_HEIGHTS_PROFILE_ENTRY, signal, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null),
    readEntry(filePath, CUSTOM_GCODE_PER_LAYER_ENTRY, signal, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null),
    readEntry(filePath, CUT_INFORMATION_ENTRY, signal, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null)
  ])

  const scene = buildSceneManifest(
    { rootModelXml, modelSettingsXml, projectSettingsJson, brimEarPointsText, layerConfigRangesXml, layerHeightsProfileText, customGcodeText, cutInformationXml },
    plateIndex,
    overrideModel
  )
  sceneCache.set(sceneCacheKey, { mtimeMs: info.mtimeMs, parserVersion: THREE_MF_PARSER_CACHE_VERSION, scene })
  return scene
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
