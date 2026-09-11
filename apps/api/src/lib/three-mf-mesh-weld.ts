/**
 * Slice-time healing for index-level triangle-soup meshes inside a 3MF.
 *
 * Editor mesh imports used to be baked with one vertex entry per triangle corner (STL is
 * soup by definition; OCCT tessellates each BRep face independently). BambuStudio's
 * slicer chains layer contours by vertex/edge INDEX (`chain_open_polylines_exact`), so a
 * soup mesh falls entirely into its 2mm proximity gap-closing heuristic, which
 * mis-stitches small features: zero-clearance inlays (embossed text pockets) print
 * fused/unfilled as if the wall generator were broken. New imports are welded at parse
 * time (`mesh-import.ts`); this module heals PREVIOUSLY-SAVED projects on their way to
 * the slicer, without touching the library file itself.
 *
 * Welding uses exact attribute-string equality (duplicated corners were serialized from
 * the same source floats), preserves every non-index triangle attribute (paint codes),
 * and drops triangles that degenerate after the weld. Already-welded meshes pass through
 * untouched, so running this over BambuStudio-authored entries is a no-op.
 */
import yauzl from 'yauzl'
import { isThreeMfModelEntryPath, weldModelEntryMeshes } from '@printstream/shared/three-mf'
import { readEntry, rewriteThreeMfEntries } from './three-mf-internal.js'

export { weldModelEntryMeshes } from '@printstream/shared/three-mf'

/** List every archive entry whose XML can contain 3MF mesh geometry. */
export function listThreeMfModelEntryNames(sourcePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(sourcePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('Failed to open 3MF'))
        return
      }
      const names: string[] = []
      zipFile.on('error', reject)
      zipFile.on('end', () => resolve(names))
      zipFile.on('entry', (entry: { fileName: string }) => {
        if (isThreeMfModelEntryPath(entry.fileName)) names.push(entry.fileName)
        zipFile.readEntry()
      })
      zipFile.readEntry()
    })
  })
}

/** Same cap the scene reader uses for the root model entry. */
const MAX_MODEL_ENTRY_BYTES = 64 * 1024 * 1024

/**
 * Produce a copy of `sourcePath` at `outputPath` with all soup meshes welded. Returns
 * true when a healed copy was written; false when every mesh was already welded (no
 * copy is produced: the caller keeps slicing the original).
 */
export async function healUnweldedThreeMfMeshes(sourcePath: string, outputPath: string): Promise<boolean> {
  const entryNames = await listThreeMfModelEntryNames(sourcePath)
  const transforms: Record<string, (xml: string) => string> = {}
  for (const name of entryNames) {
    let xml: string
    try {
      xml = (await readEntry(sourcePath, name, undefined, MAX_MODEL_ENTRY_BYTES)).toString('utf8')
    } catch (error) {
      // An oversized/unreadable entry is left as-is: healing is best-effort and must
      // never fail a slice that would previously have run.
      console.warn(`[slicing] mesh-weld heal skipped ${name}:`, error instanceof Error ? error.message : error)
      continue
    }
    const welded = weldModelEntryMeshes(xml)
    if (welded != null) transforms[name] = () => welded
  }
  if (Object.keys(transforms).length === 0) return false
  await rewriteThreeMfEntries(sourcePath, outputPath, transforms)
  return true
}
