/**
 * One cached read of the web source tree, for the convention guards that scan it.
 *
 * Owns the walk of `apps/web/src` and the CONTENTS of every `.ts`/`.tsx` file under it. Several
 * tests enforce a rule the type checker cannot express (no raw Joy `Modal`, no `fallback={null}`,
 * no `CssVarsProvider`, one owner per resolve route) by reading every source file and matching a
 * pattern, and each carried its own `async function* walk()` plus a `readFile` per hit.
 * `BackAwareModal.test.ts` alone drove three of them, which is ~3300 reads of ~1100 files in one
 * process.
 *
 * Contract: `readSourceTree()` answers with every source file exactly once, contents included, in
 * a stable name-sorted order. Callers do their own filtering, because each guard exempts a
 * different set (its own owner module, `.test.`/`.testkit.` harnesses, `.tsx` only) and narrowing
 * that here would quietly change what a guard covers. A caller interested in one subtree filters
 * on `relativePath` rather than asking for a different root: the whole-tree read is what the cache
 * is keyed on, and a second root would read the same files again under another key.
 *
 * Invariant: the cache is per PROCESS, and the node test runner gives each test FILE its own
 * process, so this amortises the walk WITHIN a file and never across files. Nothing here re-checks
 * the disk either: the tree is read once and then frozen for the life of the process, which is
 * right for a test run and wrong for anything longer-lived.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `apps/web/src`: the root every guard reports its offenders relative to. */
export const WEB_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface SourceFile {
  /** Absolute path, for reading a neighbour or reporting an unambiguous location. */
  absolutePath: string
  /**
   * Path relative to `WEB_SRC_ROOT`, in platform separators, which is the form the guards'
   * allow-lists are written in (`path.join('components', 'BackAwareModal.tsx')`).
   */
  relativePath: string
  /** File contents, read once per process. */
  source: string
  /** `source` split on newlines, split on first use and then shared by every caller. */
  readonly lines: readonly string[]
}

/**
 * How many files to read at once. Enough to keep the libuv thread pool busy (measured at ~200ms
 * against ~400ms one at a time, over ~1100 files), and far short of any descriptor limit.
 */
const READ_CONCURRENCY = 64

const filesByAbsolutePath = new Map<string, Promise<SourceFile>>()
let treeRead: Promise<readonly SourceFile[]> | undefined

function toSourceFile(absolutePath: string, source: string): SourceFile {
  let lines: readonly string[] | undefined
  return {
    absolutePath,
    relativePath: path.relative(WEB_SRC_ROOT, absolutePath),
    source,
    get lines() {
      lines ??= source.split('\n')
      return lines
    }
  }
}

function readCachedFile(absolutePath: string): Promise<SourceFile> {
  const cached = filesByAbsolutePath.get(absolutePath)
  if (cached) return cached
  // Cache the PROMISE, not the result, so two callers racing on one file still read it once.
  const pending = readFile(absolutePath, 'utf8').then((source) => toSourceFile(absolutePath, source))
  filesByAbsolutePath.set(absolutePath, pending)
  return pending
}

async function collectSourcePaths(directory: string, into: string[]): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  // Sorted so an offender list reads the same on every machine: readdir order is filesystem order.
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) await collectSourcePaths(full, into)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) into.push(full)
  }
  return into
}

/**
 * Every `.ts`/`.tsx` file under `apps/web/src`, contents included.
 *
 * Test files and `.testkit.` harnesses are INCLUDED, because not every guard exempts them (the
 * null-fallback rule applies to a test's own JSX as much as to a view's) and the ones that do
 * exempt them by a rule of their own. Call it as often as is convenient; every call after the
 * first is a cache hit.
 */
export function readSourceTree(): Promise<readonly SourceFile[]> {
  treeRead ??= (async () => {
    const paths = await collectSourcePaths(WEB_SRC_ROOT, [])
    const files: SourceFile[] = []
    for (let start = 0; start < paths.length; start += READ_CONCURRENCY) {
      files.push(...await Promise.all(paths.slice(start, start + READ_CONCURRENCY).map(readCachedFile)))
    }
    return files
  })()
  return treeRead
}

/**
 * One named file, by its path relative to `WEB_SRC_ROOT`.
 *
 * Shares the tree's cache both ways: a guard that reads a single module after scanning the tree
 * pays nothing, and one that only ever reads a few files never walks the tree at all.
 */
export function readSourceFile(relativePath: string): Promise<SourceFile> {
  return readCachedFile(path.resolve(WEB_SRC_ROOT, relativePath))
}
