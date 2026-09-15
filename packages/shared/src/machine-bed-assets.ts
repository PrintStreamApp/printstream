/**
 * Portable custom build-plate assets carried inside a PrintStream machine preset.
 *
 * BambuStudio stores `bed_custom_model` and `bed_custom_texture` as host filesystem paths. Those
 * paths remain for compatibility, while the namespaced fields below carry the bytes so a preset
 * can move between browsers and slicer hosts. The slicer materializes the bytes and replaces the
 * path values immediately before invoking the engine.
 */
import {
  decodeProjectAuxiliaryBase64,
  decodedBase64Length,
  encodeProjectAuxiliaryBase64
} from './project-auxiliaries.js'
import type { ProcessConfig } from './process-settings.js'

export const MAX_PORTABLE_MACHINE_BED_ASSET_BYTES = 1024 * 1024

export type PortableMachineBedAssetKind = 'model' | 'texture'

export interface PortableMachineBedAsset {
  name: string
  contentBase64: string
}

const KEYS = {
  model: {
    path: 'bed_custom_model',
    name: 'printstream_bed_model_name',
    content: 'printstream_bed_model_content'
  },
  texture: {
    path: 'bed_custom_texture',
    name: 'printstream_bed_texture_name',
    content: 'printstream_bed_texture_content'
  }
} as const

/** Every config key owned by the portable-asset layer, including BambuStudio's path fields. */
const PORTABLE_MACHINE_BED_ASSET_KEYS = Object.values(KEYS).flatMap((keys) => (
  [keys.path, keys.name, keys.content]
))

const EXTENSIONS: Record<PortableMachineBedAssetKind, readonly string[]> = {
  model: ['.stl'],
  texture: ['.png', '.svg']
}
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Whether a file has the engine-supported extension for this build-plate asset. */
export function portableMachineBedAssetNameAllowed(kind: PortableMachineBedAssetKind, name: string): boolean {
  const lower = name.toLowerCase()
  return EXTENSIONS[kind].some((extension) => lower.endsWith(extension))
}

/** Read and validate one embedded asset. Invalid legacy fields are ignored, never decoded blindly. */
export function readPortableMachineBedAsset(
  config: ProcessConfig,
  kind: PortableMachineBedAssetKind
): PortableMachineBedAsset | null {
  const keys = KEYS[kind]
  const name = config[keys.name]
  const contentBase64 = config[keys.content]
  if (typeof name !== 'string' || typeof contentBase64 !== 'string') return null
  if (!name || name.includes('/') || name.includes('\\') || !portableMachineBedAssetNameAllowed(kind, name)) return null
  if (!BASE64_PATTERN.test(contentBase64)) return null
  if (decodedBase64Length(contentBase64) > MAX_PORTABLE_MACHINE_BED_ASSET_BYTES) return null
  try {
    decodeProjectAuxiliaryBase64(contentBase64)
  } catch {
    return null
  }
  return { name, contentBase64 }
}

/** Embed browser-picked bytes and retain the standard BambuStudio path key as a readable name. */
export function setPortableMachineBedAsset(
  config: ProcessConfig,
  kind: PortableMachineBedAssetKind,
  asset: { name: string; bytes: Uint8Array }
): ProcessConfig {
  if (!asset.name || asset.name.includes('/') || asset.name.includes('\\')) {
    throw new Error('Build plate asset names cannot contain path separators.')
  }
  if (!portableMachineBedAssetNameAllowed(kind, asset.name)) {
    throw new Error(kind === 'model' ? 'The build plate model must be an STL file.' : 'The build plate texture must be a PNG or SVG file.')
  }
  if (asset.bytes.byteLength > MAX_PORTABLE_MACHINE_BED_ASSET_BYTES) {
    throw new Error('A custom build plate asset must be 1 MB or smaller.')
  }
  const keys = KEYS[kind]
  return {
    ...config,
    [keys.path]: asset.name,
    [keys.name]: asset.name,
    [keys.content]: encodeProjectAuxiliaryBase64(asset.bytes)
  }
}

/** Remove both the portable bytes and the standard filesystem-path field. */
export function clearPortableMachineBedAsset(
  config: ProcessConfig,
  kind: PortableMachineBedAssetKind
): ProcessConfig {
  const keys = KEYS[kind]
  const next = { ...config }
  delete next[keys.path]
  delete next[keys.name]
  delete next[keys.content]
  return next
}

/** Whether two configs describe the same custom bed assets, including path-only legacy values. */
export function portableMachineBedAssetsEqual(left: ProcessConfig, right: ProcessConfig): boolean {
  return PORTABLE_MACHINE_BED_ASSET_KEYS.every((key) => {
    const leftValue = left[key]
    const rightValue = right[key]
    if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
      return Array.isArray(leftValue)
        && Array.isArray(rightValue)
        && leftValue.length === rightValue.length
        && leftValue.every((value, index) => value === rightValue[index])
    }
    return leftValue === rightValue
  })
}

/** Decode an embedded asset for the slicer, or return null for a path-only BambuStudio preset. */
export function portableMachineBedAssetBytes(
  config: ProcessConfig,
  kind: PortableMachineBedAssetKind
): { name: string; bytes: Uint8Array } | null {
  const asset = readPortableMachineBedAsset(config, kind)
  return asset ? { name: asset.name, bytes: decodeProjectAuxiliaryBase64(asset.contentBase64) } : null
}

/** Remove PrintStream-only payload fields before a resolved machine config reaches the engine. */
export function stripPortableMachineBedAssetPayloads(config: ProcessConfig): ProcessConfig {
  const next = { ...config }
  for (const keys of Object.values(KEYS)) {
    delete next[keys.name]
    delete next[keys.content]
  }
  return next
}
