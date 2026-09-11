/**
 * DEV ONLY. Reports when the source on disk is NEWER than the running process, i.e. when this API
 * is serving code that no longer matches the repo.
 *
 * Owns one question and answers it honestly: "is what I am running still what is written down?" It
 * never restarts anything and never reloads anything. The service supervisor owns recovery; this
 * module independently reports whether the process it started actually contains the latest files.
 *
 * WHY: the former `tsx watch` setup ran the server as a separate child, so a dead watcher could
 * leave a healthy-looking process serving its boot-time code forever. A `packages/*` build watcher
 * that stops emitting creates the same symptom one layer up: "my edit had no effect", which reads
 * as a bug in the edit. That happened on 2026-08-30, when the API served 9-minute-old code for 14
 * hours across four rounds of "still broken".
 *
 * Its counterpart `scripts/dev/run-service-dev.mjs` PREVENTS the common causes: it restarts a
 * crashed child and polls these same source roots for changes. This remains an independent
 * diagnostic backstop for a supervisor or filesystem watcher that is alive but no longer reloading.
 *
 * Surfaced two ways, because each catches a different reader: a loud `console.error` for anyone
 * tailing the dev log, and a field on `GET /api/health`'s dev-only `runtime` block for anyone (or
 * any agent) probing the API after something looks wrong.
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'

/**
 * The trees whose freshness decides the answer.
 *
 * MUST mirror the API `dev` script's `--watch` arguments in `apps/api/package.json`. A root watched
 * there but missing here is a staleness this cannot see; a root here but not there would report a
 * change that was never going to reload anything, which is a false alarm and worse than silence.
 */
export const WATCH_ROOTS = ['apps/api/src', 'packages/shared/dist', 'packages/bridge-runtime/dist']

/**
 * Files inside a watched root that the SERVER never imports, and which therefore never reload it.
 *
 * Colocated tests are the big one: `apps/api/src` holds ~270 `*.test.ts`, none of them reachable
 * from `server.ts`, and this repo asks for a regression test with every change. Counting them meant
 * editing any test latched `stale` true for the life of the process and repeated the alarm every
 * five minutes -- a warning that is wrong most of the time, which is how a warning stops being read
 * at all. This module's own contract calls that outcome worse than silence.
 */
const IGNORED_SUFFIXES = ['.test.ts', '.test.tsx']
const IGNORED_DIRECTORIES = new Set(['test-utils', '__fixtures__'])

const SCAN_INTERVAL_MS = 30_000
/** Re-log while still stale: the first line scrolls away, and this condition lasts hours. */
const RELOG_INTERVAL_MS = 5 * 60_000

export interface DevSourceStaleness {
  /** True when a watched file is newer than this process. */
  stale: boolean
  /** The newest watched file, repo-relative. Null before the first scan completes. */
  newestPath: string | null
  newestModifiedAt: string | null
  lastCheckedAt: string | null
}

let current: DevSourceStaleness = { stale: false, newestPath: null, newestModifiedAt: null, lastCheckedAt: null }
let lastLoggedAt = 0

/** Process start, as a wall-clock millisecond stamp: what every mtime is measured against. */
const processStartedAtMs = Date.now() - Math.round(process.uptime() * 1000)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * The newest mtime under `roots`, or null when none of them exist.
 *
 * Skips `node_modules` (never watched, and the walk would dwarf everything else). A root that does
 * not exist is skipped rather than treated as an error: a fresh checkout has no `dist` yet, and
 * refusing to answer at all would turn "not built" into "not checked".
 */
async function newestModified(roots: readonly string[], base: string): Promise<{ atMs: number; path: string } | null> {
  let newest: { atMs: number; path: string } | null = null

  async function walk(absolute: string): Promise<void> {
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = path.join(absolute, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        await walk(child)
        continue
      }
      if (IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
      try {
        const info = await stat(child)
        if (!newest || info.mtimeMs > newest.atMs) newest = { atMs: info.mtimeMs, path: path.relative(base, child) }
      } catch {
        // Raced with a rebuild deleting the file: the next scan sees the replacement.
      }
    }
  }

  for (const root of roots) await walk(path.join(base, root))
  return newest
}

/**
 * One scan, as a pure-ish function of its inputs: which trees to look at, what to measure them
 * against, and where the repo is. Parameterised for the test, which needs a controlled tree and a
 * controlled reference time; the watcher below passes the real ones.
 *
 * `startedAtMs` is a REFERENCE POINT, not "now": a watched file newer than it means the running
 * process cannot contain that file's contents.
 */
export async function evaluateSourceStaleness(options: {
  roots: readonly string[]
  startedAtMs: number
  root?: string
}): Promise<DevSourceStaleness> {
  const base = options.root ?? repoRoot
  const newest = await newestModified(options.roots, base)
  const checkedAt = new Date().toISOString()
  if (!newest) return { stale: false, newestPath: null, newestModifiedAt: null, lastCheckedAt: checkedAt }
  return {
    stale: newest.atMs > options.startedAtMs,
    newestPath: newest.path,
    newestModifiedAt: new Date(newest.atMs).toISOString(),
    lastCheckedAt: checkedAt
  }
}

async function scanOnce(): Promise<void> {
  const result = await evaluateSourceStaleness({ roots: WATCH_ROOTS, startedAtMs: processStartedAtMs })
  current = result
  if (!result.stale || !result.newestPath || !result.newestModifiedAt) {
    lastLoggedAt = 0
    return
  }
  const now = Date.now()
  if (lastLoggedAt !== 0 && now - lastLoggedAt < RELOG_INTERVAL_MS) return
  lastLoggedAt = now
  console.error(
    `[dev] THIS PROCESS IS RUNNING STALE CODE. ${result.newestPath} was modified ` +
    `${result.newestModifiedAt}, after this process started (${new Date(processStartedAtMs).toISOString()}). ` +
    'Its file watcher is not reloading it. Restart the dev stack before trusting anything you test against this server.'
  )
}

/**
 * Begin watching, if this is a dev process. Safe to call unconditionally and idempotent per process.
 *
 * Fire and forget: it never throws into the caller and never blocks startup. A staleness monitor
 * that could delay or fail a boot would be worse than the problem it reports.
 */
export function startDevSourceStalenessWatch(): void {
  if (env.NODE_ENV === 'production') return
  void scanOnce().catch(() => {})
  const timer = setInterval(() => {
    void scanOnce().catch(() => {})
  }, SCAN_INTERVAL_MS)
  // Must never be the reason the process cannot exit.
  timer.unref()
}

/** Current view, for the health endpoint. All-null before the first scan finishes. */
export function devSourceStaleness(): DevSourceStaleness {
  return current
}
