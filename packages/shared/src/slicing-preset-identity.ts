/**
 * Slicing-preset **identity**: the single answer to "which preset is this?".
 *
 * Owns the preset id codec and the derived-display-type rule that every layer
 * (web slice dialog, API job resolution, slicer worker) must agree on. Before
 * this module the same three id shapes were minted and parsed in five places —
 * `buildBuiltinProfileId` in the slicer, `parseBuiltinSlicingProfileId` in the
 * API, `buildProjectSlicingProfileId` in the web app, and three independent
 * `'project:'` literals — so "the same preset" had several spellings and no
 * authoritative comparison (issue #66).
 *
 * Contract callers rely on:
 * - A preset is identified by its **id**, never by its name. Names are display
 *   text: they are lossy (the vendor prefix and `@<printer>` suffix are stripped
 *   for display), non-unique across kinds, and drift between the 3MF, the AMS,
 *   and the CLI catalogue.
 * - The three id shapes are a **persisted wire format**, not an internal detail.
 *   Builtin ids travel in slice requests and are stored on `SlicingJob` rows;
 *   custom ids are stored in the tenant's `Setting` blob. Their encodings must
 *   not change without a data migration — this module only centralises them.
 * - `id -> provenance` is total and pure: any string classifies, with unknown
 *   shapes reported as `null` rather than guessed.
 *
 * Encoding is deliberately platform-agnostic (`btoa`/`TextEncoder`, not
 * `Buffer`) because the web app imports this module in the browser. The output
 * is byte-identical to the slicer's previous `Buffer.from(name).toString('base64url')`.
 */
import type { SlicingProfileKind } from './slicing.js'

/**
 * Where a preset came from, which decides how much authority it carries.
 *
 * `project` presets are the 3MF's own embedded settings and are **the basis for
 * the slice** — they win over an identically-named installed preset because they
 * carry the user's authored overrides. `workspace` presets are tenant-uploaded
 * custom presets. `builtin` presets ship with BambuStudio.
 */
export type SlicingPresetProvenance = 'project' | 'workspace' | 'builtin'

export const BUILTIN_SLICING_PRESET_ID_PREFIX = 'builtin:'
export const CUSTOM_SLICING_PRESET_ID_PREFIX = 'custom:'
export const PROJECT_SLICING_PRESET_ID_PREFIX = 'project:'

/** A parsed preset id: the kind it belongs to and, for name-encoded shapes, the preset name it carries. */
export interface ParsedSlicingPresetId {
  provenance: SlicingPresetProvenance
  /** Absent for `custom:` ids, whose kind lives in tenant storage rather than the id. */
  kind: SlicingProfileKind | null
  /** The preset name encoded in the id. Null for `custom:` ids, which are opaque UUIDs. */
  name: string | null
}

/**
 * Classify any preset id. Returns `null` for a string that is not a preset id at
 * all, so callers can tell "unknown shape" from "known shape, no name" instead
 * of defaulting an unrecognised id into some provenance.
 */
export function parseSlicingPresetId(id: string | null | undefined): ParsedSlicingPresetId | null {
  const trimmed = id?.trim()
  if (!trimmed) return null

  const builtin = parseBuiltinSlicingPresetId(trimmed)
  if (builtin) return { provenance: 'builtin', kind: builtin.kind, name: builtin.name }

  const project = parseProjectSlicingPresetId(trimmed)
  if (project) return { provenance: 'project', kind: project.kind, name: project.name }

  if (trimmed.startsWith(CUSTOM_SLICING_PRESET_ID_PREFIX)) {
    return { provenance: 'workspace', kind: null, name: null }
  }
  return null
}

/** Provenance of a preset id, or `null` when the id is not a recognised preset id. */
export function slicingPresetProvenance(id: string | null | undefined): SlicingPresetProvenance | null {
  return parseSlicingPresetId(id)?.provenance ?? null
}

/**
 * Whether an id names a 3MF-embedded preset. Project presets are the slice's
 * basis, so they are never filtered out by printer-compatibility gates and are
 * never resolved to a preset FILE — the project's own settings already describe
 * them (see `resolveSlicingProfileFiles`).
 */
export function isProjectSlicingPresetId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(PROJECT_SLICING_PRESET_ID_PREFIX))
}

export function buildBuiltinSlicingPresetId(kind: SlicingProfileKind, name: string): string {
  return `${BUILTIN_SLICING_PRESET_ID_PREFIX}${kind}:${encodeBase64Url(name)}`
}

/**
 * Decode a `builtin:<kind>:<base64url(name)>` id. Returns `null` for any other
 * shape, an unknown kind, or an undecodable/empty name — never a partial result,
 * because a half-parsed builtin id downstream becomes a preset file path.
 */
export function parseBuiltinSlicingPresetId(id: string): { kind: SlicingProfileKind; name: string } | null {
  const match = /^builtin:([^:]+):(.+)$/.exec(id)
  if (!match) return null
  const kind = asSlicingProfileKind(match[1])
  if (!kind) return null
  try {
    const name = decodeBase64Url(match[2] as string).trim()
    return name ? { kind, name } : null
  } catch {
    return null
  }
}

export function buildProjectSlicingPresetId(kind: SlicingProfileKind, name: string): string {
  return `${PROJECT_SLICING_PRESET_ID_PREFIX}${kind}:${encodeURIComponent(name)}`
}

/** Decode a `project:<kind>:<uriComponent(name)>` id, or `null` for any other shape. */
export function parseProjectSlicingPresetId(id: string): { kind: SlicingProfileKind; name: string } | null {
  const match = /^project:([^:]+):(.+)$/.exec(id)
  if (!match) return null
  const kind = asSlicingProfileKind(match[1])
  if (!kind) return null
  try {
    const name = decodeURIComponent(match[2] as string).trim()
    return name ? { kind, name } : null
  } catch {
    return null
  }
}

function asSlicingProfileKind(value: string | undefined): SlicingProfileKind | null {
  return value === 'machine' || value === 'process' || value === 'filament' ? value : null
}

/**
 * The filament type BambuStudio **displays** for a preset, which is derived from
 * `filament_is_support` + `filament_type`/`filament_id` rather than stored.
 *
 * Mirrors `DynamicPrintConfig::get_filament_type` (BambuStudio
 * `src/libslic3r/PrintConfig.cpp`). A support filament is typed by its base
 * polymer in the preset JSON (`filament_type: ["PLA"]`) and carries a separate
 * `filament_is_support: ["1"]` flag, but every surface that shows or filters by
 * type — the AMS, the 3MF's project filaments, BambuStudio's own picker — speaks
 * the derived `PLA-S`. Comparing a project filament's `PLA-S` against a preset's
 * raw `PLA` matched nothing, hiding every valid support preset from the material
 * picker (issue #66); deriving both sides through this function is what makes
 * the exact-equality filter correct instead of forgiving.
 *
 * Returns the base type unchanged when the preset is not a support filament, and
 * `undefined` only when there is no type to speak of.
 */
export function resolveDisplayFilamentType(input: {
  filamentType?: string | null
  filamentIds?: readonly string[] | null
  filamentIsSupport?: boolean | null
}): string | undefined {
  const baseType = input.filamentType?.trim()
  if (!baseType) return undefined
  if (!input.filamentIsSupport) return baseType

  // Bambu's two first-party support filaments are keyed by filament id ahead of
  // type, because their base polymer alone does not distinguish them.
  const filamentIds = input.filamentIds ?? []
  if (filamentIds.includes('GFS00')) return 'PLA-S'
  if (filamentIds.includes('GFS01')) return 'PA-S'

  const normalizedBaseType = baseType.toUpperCase()
  if (normalizedBaseType === 'PLA') return 'PLA-S'
  if (normalizedBaseType === 'PA') return 'PA-S'
  // BambuStudio only derives an ABS support type when no `filament_id` is present.
  if (normalizedBaseType === 'ABS' && filamentIds.length === 0) return 'ABS-S'
  return baseType
}

/**
 * Whether a derived display type marks a support filament (`PLA-S`, `PA-S`,
 * `ABS-S`). Only for reading a type string that has already lost its flag —
 * prefer the `filamentIsSupport` field wherever it is carried.
 */
export function isSupportDisplayFilamentType(value: string | null | undefined): boolean {
  return /-S$/i.test(value?.trim() ?? '')
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
