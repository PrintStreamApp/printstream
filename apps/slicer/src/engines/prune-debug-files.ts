/**
 * Drops the debug artifacts an engine ships but never uses at runtime.
 *
 * Bambu's Windows zip carries its full debug symbols: a single
 * `BambuStudio.pdb` is ~1.09 GB, and with the ckeditor source maps the total is
 * 1145 MB of 1671 MB installed -- 69% of the engine, measured on a real
 * install. Nothing reads them. We slice by spawning the CLI and map its EXIT
 * CODES (`cli-exit-codes.ts`); we never symbolicate a BambuStudio stack, so the
 * symbols buy an operator nothing and cost them a gigabyte.
 *
 * That multiplies: the engine manager exists so several versions can sit side
 * by side, and three engines is ~5 GB of which ~3.4 GB is symbols.
 *
 * Only DISK is saved, not download -- the archive still arrives whole, because
 * the pin covers the published artifact and we will not rewrite what we
 * checksum. Keep `INSTALL_BYTES` in `catalogue.ts` in step with what survives
 * this, or the manager's "about N GB on disk" over-promises.
 *
 * Best-effort by contract: a file that will not delete (locked by a scanner,
 * say) must never fail an install that is otherwise complete.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Extensions safe to remove after unpacking.
 *
 * `.pdb` is Windows debug symbols. `.map` is JavaScript source maps for the
 * CEF-hosted UI BambuStudio embeds (ckeditor and friends) -- a GUI debugging
 * aid, and we run the CLI. Deliberately NOT extension-greedy: anything the
 * slicer might load at runtime stays, so this list only grows with evidence.
 */
const DEBUG_EXTENSIONS: ReadonlySet<string> = new Set(['.pdb', '.map'])

export interface PruneResult {
  files: number
  bytes: number
}

/**
 * Recursively delete debug artifacts under `root`.
 *
 * Returns what was freed so the caller can report it; an unreadable directory
 * or an undeletable file is skipped rather than thrown, since this runs after
 * a successful unpack and must not turn one into a failure.
 */
export async function pruneDebugFiles(root: string): Promise<PruneResult> {
  const result: PruneResult = { files: 0, bytes: 0 }

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!DEBUG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      try {
        const { size } = await stat(full)
        await rm(full, { force: true })
        result.files += 1
        result.bytes += size
      } catch {
        // Locked or already gone: leaving it costs disk, not correctness.
      }
    }
  }

  await walk(root)
  return result
}
