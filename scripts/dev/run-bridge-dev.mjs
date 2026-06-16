#!/usr/bin/env node
/**
 * Dev supervisor for the bridge runtime (replaces `tsx watch` for `npm run dev`).
 *
 * Why this exists instead of `tsx watch`:
 *  - `tsx watch` swallows a boot/import crash: the watcher parent keeps running
 *    while the app child is dead, and it only ever retries on a file-change
 *    event. So a single boot crash leaves the bridge permanently down.
 *  - tsx 4's change watcher does not receive inotify events on this repo's
 *    container filesystem (verified: edits never trigger a rerun, and
 *    CHOKIDAR_USEPOLLING is ignored by tsx). With no events, a crashed bridge
 *    stays dead forever and "nothing connects".
 *
 * Because the bridge is network-critical, a silent dead state is the worst
 * failure mode. This supervisor makes the dev bridge self-healing:
 *  - it runs the bridge under plain `tsx` (which EXITS on crash) and restarts it
 *    on any exit, cause-agnostic, with crash-loop backoff;
 *  - it polls the bridge source and the shared/bridge-runtime dist it imports
 *    for mtime changes and restarts on change — hot-reload that works regardless
 *    of inotify reliability (the same cross-package reload the old `--include`
 *    globs provided).
 *
 * Invoked with cwd = apps/bridge (via `npm run dev --workspace @printstream/bridge`),
 * mirroring the env-file and entrypoint the old `dev` script used so bridge path
 * resolution is unchanged.
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const bridgeDir = process.cwd()
const repoRoot = path.resolve(bridgeDir, '../..')
const envFile = path.join(repoRoot, '.env')
const entry = path.join(bridgeDir, 'src/index.ts')

// Source + compiled deps the bridge imports at boot; a change to any restarts it.
const watchRoots = [
  path.join(bridgeDir, 'src'),
  path.join(repoRoot, 'packages/shared/dist'),
  path.join(repoRoot, 'packages/bridge-runtime/dist')
]
const WATCH_INTERVAL_MS = 800
const CHANGE_DEBOUNCE_MS = 200
const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 10_000
const HEALTHY_UPTIME_MS = 3_000

let child = null
let shuttingDown = false
let backoffMs = MIN_BACKOFF_MS
let lastSpawnAt = 0
let restartTimer = null
let debounceTimer = null

function log(message) {
  console.log(`[bridge-dev] ${message}`)
}

function spawnBridge() {
  restartTimer = null
  lastSpawnAt = Date.now()
  // Run tsx in-process (`--import tsx`) rather than via the `tsx` bin, which
  // would spawn the app as a grandchild we couldn't reliably signal. With a
  // single process, the bridge shares this supervisor's process group, so it
  // dies with us (Ctrl-C / concurrently shutdown) and can never orphan.
  child = spawn('node', ['--env-file', envFile, '--import', 'tsx', entry], {
    cwd: bridgeDir,
    stdio: 'inherit',
    env: process.env
  })
  child.on('exit', (code, signal) => {
    child = null
    if (shuttingDown) return
    // A long-lived run that then exits was healthy; reset backoff so a single
    // later crash (or a deliberate reload-kill) restarts promptly.
    if (Date.now() - lastSpawnAt >= HEALTHY_UPTIME_MS) backoffMs = MIN_BACKOFF_MS
    const why = signal ? `signal ${signal}` : `code ${code}`
    log(`bridge exited (${why}); restarting in ${backoffMs}ms`)
    scheduleRespawn()
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  })
}

function scheduleRespawn() {
  if (restartTimer || shuttingDown) return
  restartTimer = setTimeout(spawnBridge, backoffMs)
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
    if (dirent.name === 'node_modules' || dirent.name.startsWith('.')) continue
    const full = path.join(dir, dirent.name)
    if (dirent.isDirectory()) {
      walk(full, visit)
    } else if (/\.(ts|js|mjs|cjs|json)$/.test(dirent.name)) {
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

log('starting bridge with crash-restart + polling hot-reload')
spawnBridge()
