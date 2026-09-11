#!/usr/bin/env node
/**
 * Dev supervisor for long-running Node services (replaces `tsx watch` for `npm run dev`).
 *
 * Why this exists instead of `tsx watch`:
 *  - `tsx watch` swallows a boot/import crash or killed child: the watcher parent keeps running
 *    while the app child is dead, and it only ever retries on a file-change event. So one OOM kill
 *    can leave the API or bridge permanently down while the dev stack still looks alive.
 *  - tsx 4's change watcher does not receive inotify events on this repo's
 *    container filesystem (verified: edits never trigger a rerun, and
 *    CHOKIDAR_USEPOLLING is ignored by tsx). With no events, a crashed service
 *    stays dead forever and "nothing connects".
 *
 * Because these services are network-critical, a silent dead state is the worst failure mode.
 * This supervisor makes them self-healing:
 *  - it runs the service under plain `tsx` (which EXITS on crash) and restarts it
 *    on any exit, cause-agnostic, with crash-loop backoff;
 *  - it polls the configured source and compiled dependency roots for mtime changes and restarts on
 *    change: hot-reload that works regardless of inotify reliability (the same cross-package reload
 *    the old `--include` globs provided).
 *
 * Invoked from each workspace with an explicit name, entrypoint, and repeatable watch roots.
 * `--env-file` is optional because devkit already injects the API environment, while the standalone
 * bridge command historically loads the repo `.env` itself.
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const serviceDir = process.cwd()
const repoRoot = path.resolve(serviceDir, '../..')
const serviceName = readRequiredFlag('--name=')
const entry = path.resolve(serviceDir, readRequiredFlag('--entry='))
const envFile = readFlag('--env-file=')
const watchRoots = readFlags('--watch=').map((root) => path.resolve(serviceDir, root))
if (watchRoots.length === 0) throw new Error('At least one --watch path is required.')

const WATCH_INTERVAL_MS = 800
const CHANGE_DEBOUNCE_MS = 200
const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 10_000
const HEALTHY_UPTIME_MS = 3_000
const IGNORED_SUFFIXES = ['.test.ts', '.test.tsx']
const IGNORED_DIRECTORIES = new Set(['node_modules', 'test-utils', '__fixtures__'])

let child = null
let shuttingDown = false
let backoffMs = MIN_BACKOFF_MS
let lastSpawnAt = 0
let restartTimer = null
let debounceTimer = null

function log(message) {
  console.log(`[${serviceName}-dev] ${message}`)
}

function warn(message) {
  console.warn(`[${serviceName}-dev] ${message}`)
}

function spawnService() {
  restartTimer = null
  lastSpawnAt = Date.now()
  // Run tsx in-process (`--import tsx`) rather than via the `tsx` bin, which
  // would spawn the app as a grandchild we couldn't reliably signal. With a
  // single process, the service shares this supervisor's process group, so it
  // dies with us (Ctrl-C / concurrently shutdown) and can never orphan.
  const nodeArgs = [...(envFile ? ['--env-file', path.resolve(serviceDir, envFile)] : []), '--import', 'tsx', entry]
  child = spawn('node', nodeArgs, {
    cwd: serviceDir,
    stdio: 'inherit',
    env: process.env
  })
  let settled = false
  const restartAfterExit = (why) => {
    if (settled) return
    settled = true
    child = null
    if (shuttingDown) return
    // A long-lived run that then exits was healthy; reset backoff so a single
    // later crash (or a deliberate reload-kill) restarts promptly.
    if (Date.now() - lastSpawnAt >= HEALTHY_UPTIME_MS) backoffMs = MIN_BACKOFF_MS
    warn(`service exited (${why}); restarting in ${backoffMs}ms`)
    scheduleRespawn()
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  }
  child.on('error', (error) => restartAfterExit(`spawn error: ${error.message}`))
  child.on('exit', (code, signal) => {
    restartAfterExit(signal ? `signal ${signal}` : `code ${code}`)
  })
}

function scheduleRespawn() {
  if (restartTimer || shuttingDown) return
  restartTimer = setTimeout(spawnService, backoffMs)
}

/** Kill the current child; its `exit` handler performs the respawn. */
function restartForChange(changedPath) {
  if (shuttingDown || !child) return
  log(`change detected (${path.relative(repoRoot, changedPath)}); reloading`)
  backoffMs = MIN_BACKOFF_MS
  child.kill('SIGTERM')
}

// --- polling watcher (inotify-independent) ---
const mtimes = new Map()

function scanForChanges() {
  let changed = null
  for (const root of watchRoots) {
    walk(root, (file, mtimeMs) => {
      const prev = mtimes.get(file)
      mtimes.set(file, mtimeMs)
      if (prev !== undefined && prev !== mtimeMs && !changed) changed = file
    })
  }
  if (changed) {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => restartForChange(changed), CHANGE_DEBOUNCE_MS)
  }
}

function walk(dir, visit) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const dirent of entries) {
    if (IGNORED_DIRECTORIES.has(dirent.name) || dirent.name.startsWith('.')) continue
    const full = path.join(dir, dirent.name)
    if (dirent.isDirectory()) {
      walk(full, visit)
    } else if (/\.(ts|js|mjs|cjs|json)$/.test(dirent.name)
      && !IGNORED_SUFFIXES.some((suffix) => dirent.name.endsWith(suffix))) {
      try {
        visit(full, statSync(full).mtimeMs)
      } catch {
        // file vanished mid-scan (e.g. tsc rewrite); ignore
      }
    }
  }
}

// Seed the mtime snapshot so the first scan doesn't trigger a spurious reload.
for (const root of watchRoots) walk(root, (file, mtimeMs) => mtimes.set(file, mtimeMs))
const watchTimer = setInterval(scanForChanges, WATCH_INTERVAL_MS)

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(watchTimer)
  if (restartTimer) clearTimeout(restartTimer)
  if (debounceTimer) clearTimeout(debounceTimer)
  if (child) child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM')
  // Give the child a moment to exit cleanly, then leave.
  setTimeout(() => process.exit(0), 300)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

function readFlag(prefix) {
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function readFlags(prefix) {
  return process.argv.slice(2)
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length))
    .filter(Boolean)
}

function readRequiredFlag(prefix) {
  const value = readFlag(prefix)
  if (!value) throw new Error(`Missing required ${prefix}<value> argument.`)
  return value
}

log('starting service with crash-restart + polling hot-reload')
spawnService()
