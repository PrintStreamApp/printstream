/**
 * Writing a BambuStudio preset BUNDLE: the archive layout and the `bundle_structure.json` manifest.
 *
 * OWNS the shape only: which entries a bundle holds, what they are called, and what the manifest
 * says about them. It does NOT zip anything: the ZIP implementation differs per surface (yazl on
 * the api, fflate in the browser), exactly as it does for {@link PresetArchiveReader} on the import
 * side, so this returns entries and lets the caller write them.
 *
 * The counterpart is `slicing-profile-parse.ts`, which reads these back. Both live in shared for
 * the same reason: a bundle we write must be one we (and BambuStudio) can read.
 *
 * WHAT BAMBUSTUDIO ACTUALLY DOES WITH THE MANIFEST, because it decides how much fidelity is worth
 * chasing: its importer SKIPS it and imports every other JSON in the archive by base name
 * (`PresetBundle.cpp:1069-1090`). So the manifest is descriptive metadata, not load-bearing, and
 * an importer cannot be broken by it. It is still written faithfully (`bundle_id`, `version`,
 * `bundle_type` and the per-kind path arrays, from `CreatePresetsDialog.cpp:4061-4150`) because
 * other tools read it and because a file claiming to be a `.bbscfg` should be one.
 *
 * TWO BUNDLE TYPES, and the extension follows the type rather than the caller's preference:
 * BambuStudio writes a "printer config bundle" (`.bbscfg`) keyed on a printer preset, and a
 * "filament config bundle" (`.bbsflmt`) keyed on a filament name. A selection holding anything but
 * filaments is therefore a printer bundle; a filament-only one is a filament bundle.
 */
import type { SlicingPresetKind } from './slicing.js'
import { PRESET_BUNDLE_MANIFEST_NAME } from './slicing-profile-parse.js'

/** One preset going into a bundle. `content` is its raw BambuStudio JSON, written verbatim. */
export interface SlicingPresetBundleEntry {
  kind: SlicingPresetKind
  name: string
  content: string
}

/** A file to write into the archive. */
export interface SlicingPresetBundleFile {
  path: string
  content: string
}

export interface SlicingPresetBundle {
  /** File name including the extension BambuStudio uses for this bundle type. */
  fileName: string
  files: SlicingPresetBundleFile[]
}

/** The directory each kind's presets are stored under, mirroring BambuStudio's own export. */
const DIRECTORY_BY_KIND: Record<SlicingPresetKind, string> = {
  machine: 'printer',
  filament: 'filament',
  process: 'process'
}

/** The manifest array each kind's paths are listed in (singular `_config`, as BambuStudio spells it). */
const MANIFEST_KEY_BY_KIND: Record<SlicingPresetKind, string> = {
  machine: 'printer_config',
  filament: 'filament_config',
  process: 'process_config'
}

/**
 * Make an archive entry name safe and unique.
 *
 * BambuStudio's importer takes the BASE name of every entry and writes it into one temp directory,
 * so two presets whose names differ only by their folder would overwrite each other there. Names
 * are deduplicated across the whole bundle rather than per directory for that reason, not for the
 * archive's sake.
 */
function uniqueFileName(name: string, taken: Set<string>): string {
  // Dot runs are collapsed and trimmed as well as the separators being stripped: filtering to safe
  // characters alone leaves `../../etc/passwd` as `.._.._etc_passwd`, which cannot traverse but is
  // an entry name no extractor should have to reason about.
  const base = name
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    || 'preset'
  let candidate = base
  let suffix = 2
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix})`
    suffix += 1
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

/**
 * Lay out a bundle for `entries`.
 *
 * `timestamp` is passed in rather than read from the clock so the result is a pure function of its
 * inputs: it lands in `bundle_id`, which is the only part of the output that would otherwise differ
 * between two identical exports and make the bundle untestable.
 */
export function buildSlicingPresetBundle(
  entries: readonly SlicingPresetBundleEntry[],
  options: { timestamp: string }
): SlicingPresetBundle {
  if (entries.length === 0) throw new Error('A preset bundle needs at least one preset')

  const taken = new Set<string>()
  const files: SlicingPresetBundleFile[] = []
  const pathsByKind: Record<SlicingPresetKind, string[]> = { machine: [], filament: [], process: [] }

  for (const entry of entries) {
    const path = `${DIRECTORY_BY_KIND[entry.kind]}/${uniqueFileName(entry.name, taken)}.json`
    files.push({ path, content: entry.content })
    pathsByKind[entry.kind].push(path)
  }

  // A bundle holding anything but filaments is a printer bundle, because that is the only type
  // whose manifest can describe a machine or process preset at all.
  const filamentOnly = entries.every((entry) => entry.kind === 'filament')
  // A printer bundle is named for what it is ABOUT, in the order BambuStudio keys them: the
  // machine, else the process. Falling straight to the first entry named a mixed bundle after a
  // filament, which reads as a filament bundle while carrying a printer bundle's manifest.
  const subject = (filamentOnly
    ? entries[0]?.name
    : entries.find((entry) => entry.kind === 'machine')?.name
      ?? entries.find((entry) => entry.kind === 'process')?.name
      ?? entries[0]?.name) ?? 'presets'

  const manifest: Record<string, unknown> = {
    // Empty, as BambuStudio writes it for an export made without a signed-in agent
    // (`CreatePresetsDialog.cpp:4068`), which is every export we make: the field is its NETWORK
    // agent's version, not the app's, and we have no such agent to name. Deliberately not our own
    // app version, which would be a different thing wearing the same key.
    version: '',
    // BambuStudio prefixes an unauthenticated export "offline_"; ours is never tied to a Bambu
    // account, so it always is.
    bundle_id: `offline_${subject}_${options.timestamp}`,
    bundle_type: filamentOnly ? 'filament config bundle' : 'printer config bundle',
    ...(filamentOnly ? { filament_name: subject } : { printer_preset_name: subject })
  }
  for (const kind of ['machine', 'filament', 'process'] as const) {
    manifest[MANIFEST_KEY_BY_KIND[kind]] = pathsByKind[kind]
  }

  files.push({ path: PRESET_BUNDLE_MANIFEST_NAME, content: JSON.stringify(manifest, null, 2) })

  return {
    fileName: `${uniqueFileName(subject, new Set())}${filamentOnly ? '.bbsflmt' : '.bbscfg'}`,
    files
  }
}
