#!/usr/bin/env node
/**
 * Dev runner. Runs web/api/bridge/shared and the slicer in one place -- the workspace container
 * under the devcontainer, or the host machine directly (no sibling slicer container either way).
 *
 * Multi-checkout dev mode is an OPT-IN layer on top, provided by the shared `@ryanewen/devkit`
 * package and off unless the machine has a marker file outside the repo. When on, it gives each
 * checkout and worktree its own hostname, database and ports so several can run at once; when off
 * -- the devcontainer, CI, any fresh clone -- this file behaves exactly as it did without it. What
 * is PrintStream-specific about it (our ports, the env our servers read, the slicer checks) lives
 * in `devkit.config.mjs`; everything else is the package's.
 *
 * Slicer:
 *   - **x86 / amd64 (the common case):** bootstrap the BambuStudio AppImage + profiles into a
 *     named volume (`scripts/dev/setup-slicer.mjs`, once) and run the slicer here under
 *     `tsx watch`, with the API pointed at `http://localhost:4010`.
 *   - **arm64 (Windows on ARM / WSL, Apple silicon, etc.):** BambuStudio is x86-only, so bootstrap an x86-64 qemu emulation
 *     environment (`scripts/dev/setup-slicer-qemu.mjs`, once) and run the same slicer here under
 *     emulation. Slower than native but real, local slicing: no remote dependency.
 *   - **`PRINTSTREAM_DEV_SLICER=remote` (any arch):** don't run a slicer in THIS process. The API
 *     uses `SLICER_SERVICE_URL` as-is; point it at a reachable slicer in `.env`. Two kinds qualify:
 *     a remote one (e.g. staging), or the container in `compose.dev.yml`, which BUILDS FROM THIS
 *     CHECKOUT and is what a host machine without BambuStudio's toolchain wants, since the image
 *     carries the lot (arm64 emulation sysroot included). That container is REBUILT here when this
 *     checkout's slicer source is newer than it, so dev always runs the code you are editing.
 *
 * Staleness: `concurrently` is deliberately given no `--kill-others` flag (a transient crash must
 * not take down the qemu slicer), so a service that dies here is tolerated silently. Two things
 * cover the consequence rather than the noise, since the damaging outcome is not a service being
 * DOWN but one still UP and serving code that no longer matches the repo:
 *   - `scripts/dev/exit-with-parent.cjs`, a preload wired into the watched workspaces' `dev`
 *     scripts, so a server whose watcher dies exits instead of orphaning onto its port;
 *   - `apps/api/src/lib/dev-source-staleness.ts`, which reports the cases that prevents
 *     (a wedged watcher, an unrebuilt package `dist`) on `GET /api/health` and in the log.
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { inheritWorktreeFiles, preflight, refreshBaselineAfterMigrations, removeRoute } from '@ryanewen/devkit'
import { inspectSlicerSource } from './slicer-image.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// A linked worktree does not receive ignored files from Git. Devkit inherits the explicitly-listed
// local config from the primary checkout before this runner tries to read it, without replacing a
// worktree's own copy. This is deliberately before preflight: its project env may itself depend on
// values loaded below.
await inheritWorktreeFiles({ repoRoot })

// `.env` is the documented place to configure dev, and every other entry point already reads it
// (the API through dotenv, `npm run dev:db` through `--env-file`). This script did not, so the
// switches IT owns -- PRINTSTREAM_DEV_SLICER above all -- could only be passed as a shell prefix,
// which reads like a bug: setting one in `.env` did nothing and said nothing. `loadEnvFile` leaves
// an already-set variable alone, exactly as dotenv does, so a shell prefix still wins over the file
// and host mode (which assigns further down) still wins over both.
if (existsSync(path.join(repoRoot, '.env'))) process.loadEnvFile(path.join(repoRoot, '.env'))

// Multi-checkout dev mode, if this machine opted into it. Returns null (touching nothing) for every
// other setup -- the devcontainer, CI, and any clone without the marker -- so the rest of this file
// behaves exactly as it did before devkit existed. See the package's config.mjs for the gate.
let hostMode = null
try {
  hostMode = await preflight({ repoRoot })
} catch (error) {
  console.error(`\n[dev] ${error.message}\n`)
  process.exit(1)
}
// Applied to the ambient environment rather than threaded through each spawn: the slicer data root
// below, `npm run dev:db`, and the watchers all need it, and Node's `--env-file` does not override
// an already-set variable, so `.env` still supplies these when host mode is off.
if (hostMode) Object.assign(process.env, hostMode.env)

const forceRemote = (process.env.PRINTSTREAM_DEV_SLICER || '').toLowerCase() === 'remote'
const runLocalSlicer = !forceRemote
const useQemuSlicer = runLocalSlicer && process.arch !== 'x64'
const DATA_ROOT = process.env.SLICER_DATA_ROOT || '/home/node/.printstream-slicer'

function runSync(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Pre-steps: db up + the two libs the apps import at boot.
runSync('npm', ['run', 'dev:db'])
runSync('npm', ['run', 'build', '--workspace', '@printstream/shared'])
runSync('npm', ['run', 'build', '--workspace', '@printstream/bridge-runtime'])

let slicerEnv = {}
if (runLocalSlicer) {
  // idempotent first-run bootstrap (native AppImage on x86, qemu emulation on arm64)
  runSync('node', [useQemuSlicer ? 'scripts/dev/setup-slicer-qemu.mjs' : 'scripts/dev/setup-slicer.mjs'])
  // One port for both halves: multi-checkout dev mode derives a per-checkout slicer port, and a
  // hardcoded URL here would point every checkout's API at the FIRST checkout's slicer (or at
  // nothing, when that one is not running).
  const slicerPort = process.env.SLICER_PORT || '4010'
  slicerEnv = {
    SLICER_SERVICE_URL: `http://localhost:${slicerPort}`,
    SLICER_TARGETS_FILE: path.join(DATA_ROOT, 'slicers', 'targets.json'),
    SLICER_WORK_DIR: process.env.SLICER_WORK_DIR || '/tmp/printstream-slicer',
    SLICER_PORT: slicerPort,
    // Offscreen-GL preload for CLI-rendered plate thumbnails, compiled by the setup scripts.
    // Explicit on both arches: the x86 dev cliPath is the repo wrapper, whose next-to-me
    // default would look in the repo tree rather than the data dir.
    SLICER_GL_SHIM: process.env.SLICER_GL_SHIM || path.join(DATA_ROOT, 'gl-osmesa-shim.so')
  }
  if (useQemuSlicer) {
    // The qemu wrapper defaults to this, but set it explicitly so a custom SLICER_DATA_ROOT works.
    slicerEnv.SLICER_QEMU_SYSROOT = process.env.SLICER_QEMU_SYSROOT || path.join(DATA_ROOT, 'x86root')
    console.log('[dev] slicer: running locally under x86-64 qemu emulation (arm64). First-run bootstrap downloads ~400MB once.')
  }
} else {
  console.log(`[dev] slicer: not running locally (PRINTSTREAM_DEV_SLICER=remote). The API uses SLICER_SERVICE_URL=${process.env.SLICER_SERVICE_URL || '(unset)'}; point it at a reachable slicer.`)
  // Rebuilt, not merely reported: in dev a container should run the code you are editing, and the
  // state this avoids is silent (a slice succeeds against the OLD build, so your change looks like
  // it did nothing rather than like it was never there). Only when the source is actually newer,
  // which costs a few hundred ms of docker inspect plus git to establish; the rebuild itself is
  // ~14s and layer-cached, and is skipped entirely on every start where nothing moved.
  const slicerSource = inspectSlicerSource({ repoRoot })
  if (slicerSource.state === 'differs') {
    console.log(`[dev] slicer: rebuilding the container, your source is newer (${slicerSource.reason})`)
    const rebuilt = spawnSync(
      'docker',
      ['compose', '-f', 'compose.dev.yml', '--profile', 'slicer', 'up', '-d', '--build', 'slicer'],
      { stdio: 'inherit', cwd: repoRoot }
    )
    // Never fatal: a slicer that failed to rebuild still serves its old build, and taking the whole
    // dev session down over it would be a worse trade than saying so and carrying on.
    if (rebuilt.status !== 0) console.warn('[dev] slicer: rebuild FAILED; the container is still running its previous build')
  }
}

const procs = [
  ['shared', 'magenta', 'npm run dev --workspace @printstream/shared'],
  ['api', 'green', 'npm run dev --workspace @printstream/api'],
  ['bridge', 'yellow', 'npm run dev --workspace @printstream/bridge'],
  ['web', 'blue', 'npm run dev --workspace @printstream/web']
]
if (runLocalSlicer) {
  procs.unshift(['slicer', 'cyan', 'npm run dev --workspace @printstream/slicer'])
}

if (hostMode) {
  for (const line of hostMode.lines) console.log(`[dev] ${line}`)
  console.log('')
  console.log(`  ${hostMode.identity.repoName}${hostMode.identity.isPrimary ? '' : ` / ${hostMode.identity.worktreeName}`}  →  ${hostMode.url}`)
  console.log(`  direct${' '.repeat(Math.max(1, hostMode.identity.repoName.length - 5))}  →  ${hostMode.directUrl}`)
  console.log('')
}

const child = spawn(
  'npx',
  [
    'concurrently',
    '-n', procs.map((p) => p[0]).join(','),
    '-c', procs.map((p) => p[1]).join(','),
    ...procs.map((p) => p[2])
  ],
  { stdio: 'inherit', cwd: repoRoot, env: { ...process.env, ...slicerEnv } }
)

// After the watchers are up, not before: a schema change reaching the primary checkout is the
// signal that every future checkout should start from newer data, but capturing it is worth no
// delay to the session that triggered it. Best-effort by contract -- see devkit's preflight.mjs.
if (hostMode) {
  try {
    refreshBaselineAfterMigrations(hostMode)
  } catch (error) {
    console.log(`[dev] baseline refresh skipped: ${error.message}`)
  }
}

// The proxy route names a port that is about to stop being served. A leftover file cannot misroute
// to another checkout (Traefik reports a bad gateway instead), so this is tidiness, not safety.
process.on('exit', () => { if (hostMode) removeRoute(hostMode.config, hostMode.identity) })
// Do NOT install a SIGINT/SIGTERM handler here. Ctrl-C already SIGINTs the whole foreground process
// group, so `concurrently` and every service receive it directly and shut down on their own. If
// run-dev instead CATCHES the signal (exits normally rather than terminating from it), the
// `npm run dev` wrapper the shell is waiting on prints a stray blank line before returning the prompt,
// regardless of how fast we then exit. Letting run-dev terminate with the signal keeps Ctrl-C clean.
// We only relay concurrently's eventual exit code. (A previous "reliable shutdown" handler added that
// blank line and a marker that raced the prompt; this is the deliberate revert. See git history.)
child.on('exit', (code) => process.exit(code ?? 0))
