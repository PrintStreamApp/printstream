/**
 * The 3MF bake, run in the browser.
 *
 * The counterpart of `apps/api/src/lib/three-mf-scene-builder.ts`: same shared plan, different ZIP
 * layer. Everything that decides WHAT the output contains lives in `@printstream/shared/three-mf`
 * (`readThreeMfBakeSource` + `planEditedThreeMf`); this module only reads entries out of an
 * already-inflated archive and writes the result with fflate. If you find yourself adding a rule
 * about 3MF content here, it belongs in the shared module instead — that is the whole point of the
 * split, and the api would otherwise not get the fix.
 *
 * Why it exists: the public editor opens a file the user picked and must be able to save it back
 * without the bytes ever leaving the machine, so there is no server to bake on.
 *
 * Memory: the api streams mesh entries past the transforms, but a browser archive is already fully
 * inflated in memory, so the peak here is roughly the source archive plus the output. That is
 * bounded by `MAX_CLIENT_THREE_MF_BYTES` at open time.
 */
import { zip } from 'fflate'
import {
  emptyThreeMfBakeSource,
  planEditedThreeMf,
  readThreeMfBakeSource,
  type ImportedObjectInput,
  type ThreeMfBakeOptions,
  type ThreeMfBakeResult
} from '@printstream/shared/three-mf'
import type { SceneEdit } from '@printstream/shared'
import type { ThreeMfArchive } from './threeMfArchive'

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
 */
export async function bakeClientThreeMf(
  archive: ThreeMfArchive | null,
  edit: SceneEdit,
  imports: ImportedObjectInput[] = [],
  options: ThreeMfBakeOptions = {}
): Promise<ClientBakeOutput> {
  const source = archive
    ? await readThreeMfBakeSource(async (entryPath) => archive.entryText(entryPath), edit)
    : emptyThreeMfBakeSource()
  const plan = planEditedThreeMf(source, edit, imports, options)

  const encoder = new TextEncoder()
  const output: Record<string, Uint8Array> = {}

  if (plan.copy && archive) {
    // Copy pass: every source entry survives unless a transform rewrites it, or returns null to
    // drop it (how a stale slice_info record is removed rather than carried forward).
    for (const entryPath of archive.entryNames()) {
      const transform = plan.copy.transforms.get(entryPath)
      if (!transform) {
        const bytes = archive.entryBytes(entryPath)
        if (bytes) output[entryPath] = bytes
        continue
      }
      const rewritten = transform(archive.entryText(entryPath) ?? '')
      if (rewritten !== null) output[entryPath] = encoder.encode(rewritten)
    }
    // Appended entries never displace one the copy pass already wrote — a 3MF reader rejects an
    // archive with duplicate names, and the transform is the more specific answer for that entry.
    for (const extra of plan.copy.appendEntries) {
      if (output[extra.name] === undefined) output[extra.name] = encoder.encode(extra.content)
    }
  } else {
    for (const entry of plan.freshEntries ?? []) output[entry.name] = encoder.encode(entry.content)
  }

  return { bytes: await deflateArchive(output), result: plan.result }
}

/** fflate's callback zip as a promise. Level 6 matches what BambuStudio writes. */
function deflateArchive(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })
}
