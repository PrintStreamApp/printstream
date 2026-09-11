/**
 * The 3MF bake, run in the browser.
 *
 * The counterpart of `apps/api/src/lib/three-mf-scene-builder.ts`: same shared plan, different ZIP
 * layer. Everything that decides WHAT the output contains lives in `@printstream/shared/three-mf`
 * (`readThreeMfBakeSource` + `planEditedThreeMf`); this module only reads entries out of an
 * already-inflated archive and writes the result with fflate. If you find yourself adding a rule
 * about 3MF content here, it belongs in the shared module instead, that is the whole point of the
 * split, and the api would otherwise not get the fix.
 *
 * Why it exists: the public editor opens a file the user picked and must be able to save it back
 * without the bytes ever leaving the machine, so there is no server to bake on.
 *
 * Memory: the api streams mesh entries past the transforms, but a browser archive is already fully
 * inflated in memory, so the peak here is roughly the source archive plus the output. That is
 * bounded by `MAX_CLIENT_THREE_MF_BYTES` at open time.
 */
import { zipArchiveEntries } from './zipArchiveClient'
import {
  decodePlateThumbnails,
  emptyThreeMfBakeSource,
  isThreeMfModelEntryPath,
  planEditedThreeMf,
  plateThumbnailEntries,
  readThreeMfBakeSource,
  type ImportedObjectInput,
  type ThreeMfBakeOptions,
  type ThreeMfBakeResult,
  weldModelEntryMeshes
} from '@printstream/shared/three-mf'
import type { SceneEdit } from '@printstream/shared'
import { applyBakeSettingsPasses, type ClientBakeSettingsPasses } from './clientBakeSettingsPasses'
import type { ThreeMfArchive } from './threeMfArchive'

/**
 * Base64 to bytes, through the platform decoder the browser already has.
 *
 * `atob` yields one character per byte, which is exactly the mapping `charCodeAt` reverses; it
 * throws on a malformed string, which is what lets the caller drop an undecodable preview.
 */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export interface ClientBakeOutput {
  /** The finished 3MF, ready to hand to a download or the File System Access API. */
  bytes: Uint8Array
  /** Baked object ids the caller needs to re-key per-object overrides. */
  result: ThreeMfBakeResult
}

/**
 * Bake a `SceneEdit` against an open archive (or against nothing, for a project built from
 * scratch) and return the resulting 3MF bytes.
 *
 * `archive` null means a from-scratch project: the plan then supplies the complete entry list
 * rather than a set of rewrites.
 *
 * `machineRetarget` saves the project FOR A DIFFERENT PRINTER. It runs after the bake and before
 * the archive is written, which is the same position the api's `retargetSavedProjectMachine` pass
 * holds relative to its own bake, deliberately, so the two hosts produce the same file. It is a
 * separate parameter rather than a `ThreeMfBakeOptions` field because the plan is RESOLVED input
 * (preset configs the host fetched), not a bake decision, and it is a FUNCTION of the baked
 * settings because the rebind targets are picked from the filament list this bake just wrote.
 */
export async function bakeClientThreeMf(
  archive: ThreeMfArchive | null,
  edit: SceneEdit,
  imports: ImportedObjectInput[] = [],
  options: ThreeMfBakeOptions = {},
  settingsPasses: ClientBakeSettingsPasses = {},
  signal?: AbortSignal
): Promise<ClientBakeOutput> {
  signal?.throwIfAborted()
  const source = archive
    ? await readThreeMfBakeSource(async (entryPath) => archive.entryText(entryPath), edit)
    : emptyThreeMfBakeSource()
  signal?.throwIfAborted()
  const plan = planEditedThreeMf(source, edit, imports, options)

  const encoder = new TextEncoder()
  const output: Record<string, Uint8Array> = {}

  if (plan.copy && archive) {
    // Copy pass: every source entry survives unless a transform rewrites it, or returns null to
    // drop it (how a stale slice_info record is removed rather than carried forward).
    for (const entryPath of archive.entryNames()) {
      signal?.throwIfAborted()
      const transform = plan.copy.transforms.get(entryPath)
      if (!transform) {
        const bytes = archive.entryBytes(entryPath)
        if (bytes) output[entryPath] = bytes
        continue
      }
      const rewritten = transform(archive.entryText(entryPath) ?? '')
      if (rewritten !== null) output[entryPath] = encoder.encode(rewritten)
    }
    // Appended entries never displace one the copy pass already wrote, a 3MF reader rejects an
    // archive with duplicate names, and the transform is the more specific answer for that entry.
    for (const extra of plan.copy.appendEntries) {
      signal?.throwIfAborted()
      if (output[extra.name] === undefined) output[extra.name] = encoder.encode(extra.content)
    }
  } else {
    for (const entry of plan.freshEntries ?? []) {
      signal?.throwIfAborted()
      output[entry.name] = encoder.encode(entry.content)
    }
  }

  // The editor's own plate renders, written LAST so they replace whatever the base archive carried.
  // A save runs no slicer, so nothing else regenerates these: without this the file keeps the
  // previews of the layout as it was BEFORE the edit, and every surface that reads them (the library
  // card, the plate strip, BambuStudio's project view) shows the stale one saying nothing.
  for (const entry of plateThumbnailEntries(decodePlateThumbnails(edit.plateThumbnails, decodeBase64))) {
    output[entry.name] = entry.png
  }

  // Everything that rewrites the settings the bake just wrote, in the order that module owns.
  await applyBakeSettingsPasses(output, edit, settingsPasses)
  signal?.throwIfAborted()

  // Prepared slice snapshots bypass server-side content mutation. Heal legacy triangle-soup
  // imports here so the uploaded archive has the same engine-ready geometry as the old server
  // preparation path. Exact-coordinate welding is a no-op for current and Studio-authored meshes.
  if (settingsPasses.sliceTarget) {
    for (const [entryPath, bytes] of Object.entries(output)) {
      signal?.throwIfAborted()
      if (!isThreeMfModelEntryPath(entryPath)) continue
      const welded = weldModelEntryMeshes(new TextDecoder().decode(bytes))
      if (welded != null) output[entryPath] = encoder.encode(welded)
    }
  }

  // Judge the bake on what it WROTE, the same check the api runs after its own write
  // (`three-mf-scene-builder.ts`). This host needs it more, not less: the api can re-inspect a
  // stored file later, while the public editor hands the bytes straight back to the user's disk and
  // never sees them again. Runs after the transforms, since the project-settings one is lazy.
  //
  // Reports and never rewrites, for the same reason as the api: healing here would hide the
  // authoring bug that produced the defect, and repairs are the user's to ask for.
  const settingsRepairReasons = plan.settingsRepairReasons()
  if (settingsRepairReasons.length > 0) {
    console.warn(`[three-mf-bake] wrote a project with repairable settings defects: ${settingsRepairReasons.join(', ')}`)
  }

  return { bytes: await deflateArchive(output, signal), result: plan.result }
}

/**
 * Deflate through the dedicated zip worker (bounded, always settles, a wedged save must surface
 * an error, never hang "Saving…"). Level 6 matches what BambuStudio writes.
 */
function deflateArchive(entries: Record<string, Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  return zipArchiveEntries(entries, 6, signal)
}
