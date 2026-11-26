/**
 * Runtime file observations for the API/bridge polling supervisor.
 * Compare content after metadata changes so tsc rewrites do not disconnect the
 * printer fleet. Test outputs and type declarations cannot change service code.
 * The supervisor owns debounce, crashes and process lifetime.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ignoredDirectories = new Set(['node_modules', 'test-utils', '__fixtures__'])
const ignoredSuffixes = ['.d.ts', '.d.mts', '.d.cts', '.test.ts', '.test.tsx',
  '.test.js', '.test.jsx', '.test.mjs', '.test.cjs']

/**
 * Read watched runtime files and report one changed path, including additions
 * and deletions. Roots may name directories or explicit runtime config files;
 * directory traversal still ignores hidden files. An absent prior snapshot
 * seeds observations without a reload.
 * Reuse digests while metadata is stable; unreadable mid-write files retain
 * their previous observation and are retried on the next scan.
 */
export function scanServiceWatchRoots(roots, previous = null) {
  const next = new Map()
  let changedPath = null

  const visit = (file) => {
    if (next.has(file)) return
    const prior = previous?.get(file)
    try {
      const stat = statSync(file)
      const identity = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`
      const digest = prior?.identity === identity
        ? prior.digest
        : createHash('sha256').update(readFileSync(file)).digest('hex')
      next.set(file, { identity, digest })
      if (previous && prior?.digest !== digest && changedPath === null) changedPath = file
    } catch {
      if (prior) next.set(file, prior)
    }
  }

  const walk = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      // A transient unreadable dependency directory is not a mass deletion.
      for (const [file, observation] of previous ?? []) {
        if (file.startsWith(`${directory}${path.sep}`)) next.set(file, observation)
      }
      return
    }
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name) || entry.name.startsWith('.')) continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(file)
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(entry.name)
        && !ignoredSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
        visit(file)
      }
    }
  }

  for (const root of roots) {
    try {
      if (statSync(root).isFile()) {
        // Only explicitly named files bypass the directory filters. This lets
        // an API watch its own .env without observing other services' secrets.
        visit(root)
      } else {
        walk(root)
      }
    } catch (error) {
      if (previous?.has(root)) {
        // A removed config must reload the child so dotenv stops granting its
        // old values. Keep observations for other failures during a write.
        if (error.code !== 'ENOENT') next.set(root, previous.get(root))
      } else {
        walk(root)
      }
    }
  }
  if (previous && changedPath === null) {
    changedPath = [...previous.keys()].find((file) => !next.has(file)) ?? null
  }
  return { observations: next, changedPath }
}
