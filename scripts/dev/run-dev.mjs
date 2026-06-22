#!/usr/bin/env node
/**
 * Dev runner. Runs web/api/bridge/shared and the slicer, all inside the workspace container
 * (no sibling slicer container).
 *
 * Slicer:
 *   - **x86 / amd64 (the common case):** bootstrap the BambuStudio AppImage + profiles into a
 *     named volume (`scripts/dev/setup-slicer.mjs`, once) and run the slicer here under
 *     `tsx watch`, with the API pointed at `http://localhost:4010`.
 *   - **arm64 (Windows on ARM / WSL, Apple silicon, etc.):** BambuStudio is x86-only, so bootstrap an x86-64 qemu emulation
 *     environment (`scripts/dev/setup-slicer-qemu.mjs`, once) and run the same slicer here under
 *     emulation. Slower than native but real, local slicing — no remote dependency.
 *   - **`PRINTSTREAM_DEV_SLICER=remote` (any arch):** don't run a local slicer. The API uses
 *     `SLICER_SERVICE_URL` as-is — point it at a reachable x86 slicer (e.g. staging) in `.env`.
 */
import { spawnSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
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
  slicerEnv = {
    SLICER_SERVICE_URL: 'http://localhost:4010',
    SLICER_TARGETS_FILE: path.join(DATA_ROOT, 'slicers', 'targets.json'),
    SLICER_WORK_DIR: process.env.SLICER_WORK_DIR || '/tmp/printstream-slicer',
    SLICER_PORT: process.env.SLICER_PORT || '4010'
  }
  if (useQemuSlicer) {
    // The qemu wrapper defaults to this, but set it explicitly so a custom SLICER_DATA_ROOT works.
    slicerEnv.SLICER_QEMU_SYSROOT = process.env.SLICER_QEMU_SYSROOT || path.join(DATA_ROOT, 'x86root')
    console.log('[dev] slicer: running locally under x86-64 qemu emulation (arm64). First-run bootstrap downloads ~400MB once.')
  }
} else {
  console.log(`[dev] slicer: not running locally (PRINTSTREAM_DEV_SLICER=remote). The API uses SLICER_SERVICE_URL=${process.env.SLICER_SERVICE_URL || '(unset)'} — point it at a reachable x86 slicer.`)
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
// Do NOT install a SIGINT/SIGTERM handler here. Ctrl-C already SIGINTs the whole foreground process
// group, so `concurrently` and every service receive it directly and shut down on their own. If
// run-dev instead CATCHES the signal (exits normally rather than terminating from it), the
// `npm run dev` wrapper the shell is waiting on prints a stray blank line before returning the prompt
// — regardless of how fast we then exit. Letting run-dev terminate with the signal keeps Ctrl-C clean.
// We only relay concurrently's eventual exit code. (A previous "reliable shutdown" handler added that
// blank line and a marker that raced the prompt; this is the deliberate revert — see git history.)
child.on('exit', (code) => process.exit(code ?? 0))
