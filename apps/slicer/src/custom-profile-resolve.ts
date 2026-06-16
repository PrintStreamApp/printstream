/**
 * Resolves a custom (User) slicer profile into a complete config by merging it
 * onto the fully-resolved system preset it inherits from.
 *
 * BambuStudio stores User presets as sparse diffs: only the keys that differ
 * from the parent, plus bookkeeping fields (`name`, `inherits`, `from`,
 * `type`). The BambuStudio CLI does NOT resolve a process or machine profile's
 * `inherits` chain when it loads one via `--load-settings` (only filament
 * presets get an inherit merge, and even then only for a subset of keys). A
 * sparse custom process therefore arrives missing inherited fields such as
 * `compatible_printers`, and the CLI rejects it as "process not compatible with
 * printer" (exit 239) because it cannot see which printers the process targets.
 *
 * To behave like BambuStudio's own runtime preset materialization we merge the
 * custom diff on top of the system preset found at
 * `<profileDir>/<kind>_full/<inherits>.json`. The custom keys win; everything
 * else (including `compatible_printers` and the tuned defaults) comes from the
 * resolved base. When the parent cannot be found we fall back to the custom
 * profile as authored so slicing still proceeds.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SlicingProfileKind } from '@printstream/shared'
import { sanitizeProfileFileName } from './profile-file-name.js'

type ProfileRecord = Record<string, unknown>

/**
 * Reads a system preset by name from `<profileDir>/<kind>_full/`. Returns null
 * when the preset file does not exist (e.g. internal `fdm_*` templates that are
 * not shipped as instantiable presets).
 */
export type SystemPresetReader = (kind: SlicingProfileKind, name: string) => Promise<ProfileRecord | null>

/**
 * Merges a custom profile's JSON `content` onto its inherited system base and
 * returns the resolved config with `type` normalized to `kind`.
 */
export async function resolveCustomProfileConfig(
  content: string,
  kind: SlicingProfileKind,
  profileDir: string
): Promise<ProfileRecord> {
  return resolveCustomProfileConfigWith(content, kind, createFileSystemPresetReader(profileDir))
}

/**
 * Variant of {@link resolveCustomProfileConfig} with an injectable preset
 * reader so the merge behavior can be unit-tested without touching disk.
 */
export async function resolveCustomProfileConfigWith(
  content: string,
  kind: SlicingProfileKind,
  readSystemPreset: SystemPresetReader
): Promise<ProfileRecord> {
  const custom = JSON.parse(content) as ProfileRecord
  const merged = await mergeInheritedBase(custom, kind, readSystemPreset, new Set())
  merged.type = kind
  return merged
}

function createFileSystemPresetReader(profileDir: string): SystemPresetReader {
  return async (kind, name) => {
    const presetPath = path.join(profileDir, `${kind}_full`, `${sanitizeProfileFileName(name)}.json`)
    let raw: string
    try {
      raw = await readFile(presetPath, 'utf8')
    } catch {
      return null
    }
    return JSON.parse(raw) as ProfileRecord
  }
}

async function mergeInheritedBase(
  profile: ProfileRecord,
  kind: SlicingProfileKind,
  readSystemPreset: SystemPresetReader,
  visited: Set<string>
): Promise<ProfileRecord> {
  const inherits = typeof profile.inherits === 'string' ? profile.inherits.trim() : ''
  if (!inherits || visited.has(inherits)) return { ...profile }
  visited.add(inherits)

  const base = await readSystemPreset(kind, inherits)
  if (!base) return { ...profile }

  const resolvedBase = await mergeInheritedBase(base, kind, readSystemPreset, visited)
  return { ...resolvedBase, ...profile }
}
