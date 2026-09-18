#!/usr/bin/env node
/**
 * Dev runner. Devkit orchestrates this checkout's source-mounted Node, PostgreSQL, and slicer
 * containers, plus a host bridge that retains access to the printer LAN. Compose reinvokes this
 * file with `--container-runtime` to prepare the database and run the web, API, shared, and
 * optional in-process slicer watchers.
 *
 * Slicer:
 *   - **x86 / amd64 (the common case):** bootstrap the BambuStudio AppImage + profiles into a
 *     named volume (`scripts/dev/setup-slicer.mjs`, once) and run the slicer here under
 *     `tsx watch`, with the API pointed at the configured local slicer port.
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

import {
  checkoutCompose,
  checkoutComposeLifecycle,
  inheritWorktreeFiles,
  preflight
} from '@ryanewen/devkit'
import { DEV_PORTS } from '../../devkit.config.mjs'
import { assertHostDevPortsAvailable } from './dev-port-guard.mjs'
import { hostBridgeProcessSpec, stopHostService } from './host-bridge.mjs'
import {
  inspectSlicerSource,
  slicerComposeUpArgs,
  slicerDevImageRef,
  slicerSourceFingerprint
} from './slicer-image.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const containerRuntime = process.argv.includes('--container-runtime')
const teardown = process.argv.includes('--down')

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

// The host invocation obtains checkout-specific resources from Devkit. Compose reinvokes this
// runner with `--container-runtime`, where those values are already present in the environment.
let hostMode = null
if (!containerRuntime) {
  try {
    hostMode = await preflight({ repoRoot, teardown })
    if (!hostMode) {
      console.error('\n[dev] Devkit is not enabled; run `npm run dev:bootstrap` once on this host.\n')
      process.exit(1)
    }
    if (!teardown) await assertHostDevPortsAvailable(hostMode)
  } catch (error) {
    console.error(`\n[dev] ${error.message}\n`)
    process.exit(1)
  }
}
// Applied to the ambient environment rather than threaded through each spawn: the slicer data root
// below, `npm run dev:db`, and the watchers all need it, and Node's `--env-file` does not override
// an already-set variable, so `.env` still supplies these when host mode is off.
if (hostMode) Object.assign(process.env, hostMode.env)

const forceRemote = (process.env.PRINTSTREAM_DEV_SLICER || '').toLowerCase() === 'remote'
const runLocalSlicer = !forceRemote
const useQemuSlicer = runLocalSlicer && process.arch !== 'x64'
const DATA_ROOT = process.env.SLICER_DATA_ROOT || '/home/node/.printstream-slicer'

function runSync(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** Absolute common Git directory, mounted into linked-worktree containers for read-only discovery. */
function resolveGitCommonDirectory() {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const commonDir = result.stdout?.trim()
  if (result.status !== 0 || !commonDir) {
    throw new Error(`Could not resolve the Git common directory: ${result.stderr?.trim() || 'git returned no path'}`)
  }
  return path.resolve(repoRoot, commonDir)
}

let composeInvocation = null
let composeLifecycle = null
let checkoutSlicerImage = null
let checkoutSlicerSourceFingerprint = null
if (hostMode) {
  // The bridge is the one host-side service: Docker Desktop cannot route this machine's Compose
  // networks to the printer LAN. Build its shared imports before starting its polling supervisor;
  // the source-mounted container will keep the same outputs current after startup.
  if (!teardown) {
    runSync('npm', ['run', 'build', '--workspace', '@printstream/shared'])
    runSync('npm', ['run', 'build', '--workspace', '@printstream/bridge-runtime'])
    runSync('npm', ['run', 'build', '--workspace', '@printstream/sea-runtime'])
  }

  checkoutSlicerSourceFingerprint = slicerSourceFingerprint(repoRoot)
  checkoutSlicerImage = slicerDevImageRef(
    checkoutSlicerSourceFingerprint,
    hostMode.identity.composeProject
  )
  composeInvocation = checkoutCompose(hostMode, {
    files: [path.join(repoRoot, 'compose.dev.yml')],
    projectDirectory: repoRoot,
    env: {
      DEVKIT_WEB_PORT: String(hostMode.ports.web),
      DEVKIT_API_PORT: String(hostMode.ports.api),
      DEVKIT_COMPOSE_PROJECT: hostMode.identity.composeProject,
      SLICER_IMAGE: checkoutSlicerImage,
      SLICER_SOURCE_FINGERPRINT: checkoutSlicerSourceFingerprint || 'unknown',
      PRINTSTREAM_GIT_COMMON_DIR: resolveGitCommonDirectory(),
      HOST_UID: String(process.getuid?.() ?? 1000),
      HOST_GID: String(process.getgid?.() ?? 1000)
    }
  })
  composeLifecycle = checkoutComposeLifecycle(hostMode, composeInvocation, {
    profiles: ['slicer']
  })
  if (teardown) {
    process.exit(composeLifecycle.stop())
  }
} else {
  if (containerRuntime) {
    // The client is install-local and a fresh worktree has none. Generate it on
    // every start so `npm ci && npm run dev` is the complete bootstrap path and
    // a schema edit cannot accidentally run against stale generated types.
    runSync('npm', ['run', 'db:generate'])
    runSync('npm', ['run', 'db:wait'])
    runSync('node', ['scripts/bootstrap-prisma-migrations.mjs'])
  } else {
    runSync('npm', ['run', 'dev:db'])
  }
  runSync('npm', ['run', 'build', '--workspace', '@printstream/shared'])
  runSync('npm', ['run', 'build', '--workspace', '@printstream/bridge-runtime'])
  runSync('npm', ['run', 'build', '--workspace', '@printstream/sea-runtime'])
}

let slicerEnv = {}
if (runLocalSlicer) {
  // idempotent first-run bootstrap (native AppImage on x86, qemu emulation on arm64)
  runSync('node', [useQemuSlicer ? 'scripts/dev/setup-slicer-qemu.mjs' : 'scripts/dev/setup-slicer.mjs'])
  // One port for both halves: multi-checkout dev mode derives a per-checkout slicer port, and a
  // hardcoded URL here would point every checkout's API at the FIRST checkout's slicer (or at
  // nothing, when that one is not running).
  const slicerPort = process.env.SLICER_PORT || DEV_PORTS.slicer
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
  // A container-mode slicer always starts with this checkout. Its image is rebuilt only when the
  // source fingerprint differs; identical worktrees reuse the completed image and shared engine
  // volume while their isolated networks safely reuse internal port 4010.
  const slicerSource = inspectSlicerSource({
    repoRoot,
    composeProject: hostMode?.identity.composeProject,
    imageRef: checkoutSlicerImage,
    sourceFingerprint: checkoutSlicerSourceFingerprint
  })
  if (composeInvocation) {
    const rebuild = ['differs', 'not-built'].includes(slicerSource.state)
    if (rebuild) {
      const reason = slicerSource.state === 'differs'
        ? `your source is newer (${slicerSource.reason})`
        : 'this checkout has no slicer image yet'
      console.log(`[dev] slicer: building the checkout container, ${reason}`)
    } else {
      console.log(`[dev] slicer: starting the checkout container from shared image ${checkoutSlicerImage}`)
    }
    const started = spawnSync(
      composeInvocation.command,
      [...composeInvocation.args, ...slicerComposeUpArgs(slicerSource.state)],
      { stdio: 'inherit', cwd: repoRoot, env: composeInvocation.env }
    )
    // Never fatal: the API already treats an unavailable remote slicer as a service-level error.
    // Keeping the rest of dev up leaves the web, API and bridge available while it is repaired.
    if (started.status !== 0) console.warn('[dev] slicer: checkout container start FAILED; continuing without it')
  }
}

const procs = [
  ['shared', 'magenta', 'npm run dev --workspace @printstream/shared'],
  ['api', 'green', 'npm run dev --workspace @printstream/api'],
  ['web', 'blue', 'npm run dev --workspace @printstream/web']
]
if (process.env.PRINTSTREAM_DEV_BRIDGE !== 'host') {
  procs.splice(2, 0, ['bridge', 'yellow', 'npm run dev --workspace @printstream/bridge'])
}
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

if (composeLifecycle) {
  const bridgeSpec = hostBridgeProcessSpec({
    repoRoot,
    apiPort: hostMode.ports.api
  })
  const hostBridge = spawn(bridgeSpec.command, bridgeSpec.args, bridgeSpec.options)
  hostBridge.on('error', (error) => {
    console.error(`[dev] could not start the host bridge: ${error.message}`)
  })

  let exitCode = 1
  try {
    // Compose builds a declared image when it is absent. Existing images stay untouched here;
    // the slicer-specific freshness check above is the one authority that requests a rebuild.
    exitCode = await composeLifecycle.run(['up', '--remove-orphans'])
  } catch (error) {
    console.error(`[dev] could not start Docker Compose: ${error.message}`)
  } finally {
    await stopHostService(hostBridge)
  }
  process.exit(exitCode)
}

// Without Devkit, the foreground process group owns its own children and needs no Compose cleanup.
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
child.on('exit', (code) => process.exit(code ?? 0))
