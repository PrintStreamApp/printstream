/**
 * The browser half of AMF import: unzipping a zipped `.amf` so the shared parser can read it.
 *
 * PARSING is shared (`@printstream/shared/three-mf` `mesh-amf.ts`); this module exists only because
 * an `.amf` may be raw XML or a ZIP containing one, and the shared package has no ZIP layer by
 * design. It is the AMF counterpart of `localStepImport.ts` (which owns the OCCT WASM loading) and
 * `localThreeMfImport.ts` (which owns the in-tab archive): each supplies the one host-shaped thing
 * its format needs, and nothing about the resulting mesh differs between the hosts.
 *
 * The api's counterpart is `readZippedAmf` in `apps/api/src/lib/mesh-import.ts`, which does the same
 * job with yauzl. Both pick the first `.amf` entry, or the first entry at all, so a file imports the
 * same either side.
 *
 * fflate's SYNC codec deliberately, not its async one: the callers are already off the main thread
 * (the staging worker) or already in the main-thread last-resort fallback, and the async API spawns
 * a worker per entry and can wedge without erroring under CPU starvation -- the failure that left
 * the editor on "Loading plates..." forever with leaked workers. See `zipArchiveClient.ts`.
 */
import { unzipSync, strFromU8 } from 'fflate'
import { MAX_AMF_SOURCE_BYTES, ModelImportError } from '@printstream/shared/three-mf'

/**
 * Largest AMF document to decode out of an archive, shared with the API as
 * `MAX_AMF_SOURCE_BYTES`.
 *
 * An unbounded read here is a zip bomb: a few KB of input expanding until the tab dies, taking the
 * user's unsaved project with it. The api caps the same read and says so; the two must agree, or a
 * file that is merely refused on one host is a crash on the other.
 */
/**
 * The AMF document inside a zipped `.amf`.
 *
 * Prefers an entry actually named `*.amf`, because the spec's own packaging puts the document
 * alongside optional resources; falls back to the first non-directory entry so a file written by a
 * tool that named it something else still imports. The api's `readZippedAmf` applies the SAME
 * preference deliberately, so an archive resolves to the same entry either side.
 *
 * Every refusal is a `ModelImportError`, which is what the staging worker's `isDataError` matches on
 * -- so a bad archive is reported rather than retried on the main thread.
 */
export function readZippedAmfDocument(bytes: Uint8Array): string {
  let entries: Record<string, Uint8Array>
  let sawAmf = false
  let selectedAmf = false
  let oversizedDocument = false
  try {
    entries = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name.endsWith('/') || !entry.name.toLowerCase().endsWith('.amf')) return false
        sawAmf = true
        if (selectedAmf) return false
        selectedAmf = true
        if (entry.originalSize > MAX_AMF_SOURCE_BYTES) { oversizedDocument = true; return false }
        return true
      }
    })
    // Compatibility fallback for archives whose document lacks the conventional extension. A
    // second central-directory pass is cheap and lets the first pass avoid inflating unrelated
    // resources merely to discover whether a preferred entry exists later in the archive.
    if (!sawAmf) {
      let selectedFallback = false
      entries = unzipSync(bytes, {
        filter: (entry) => {
          if (entry.name.endsWith('/') || selectedFallback) return false
          selectedFallback = true
          if (entry.originalSize > MAX_AMF_SOURCE_BYTES) { oversizedDocument = true; return false }
          return true
        }
      })
    }
  } catch {
    throw new ModelImportError('AMF archive could not be read')
  }
  const names = Object.keys(entries).filter((name) => !name.endsWith('/'))
  const chosen = names.find((name) => name.toLowerCase().endsWith('.amf')) ?? names[0]
  const document = chosen == null ? undefined : entries[chosen]
  if (!document && oversizedDocument) throw new ModelImportError('AMF is too large to import')
  if (!document) throw new ModelImportError('AMF archive contained no document')
  // The filter rejected on the central-directory size before inflation; this measured check keeps
  // the host invariant explicit if the codec ever accepts an archive whose declaration is wrong.
  if (document.byteLength > MAX_AMF_SOURCE_BYTES) throw new ModelImportError('AMF is too large to import')
  return strFromU8(document)
}
