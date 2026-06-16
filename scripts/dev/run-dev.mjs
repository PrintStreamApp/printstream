#!/usr/bin/env node
/**
 * Dev runner. Runs web/api/bridge/shared and — on x86 — the slicer, all inside the workspace
 * container (no sibling slicer container).
 *
 * Slicer:
 *   - **x86 (default):** bootstrap the BambuStudio AppImage + profiles into a named volume
 *     (`scripts/dev/setup-slicer.mjs`, once) and run the slicer here under `tsx watch`, with the
 *     API pointed at `http://localhost:4010`.
 *   - **arm64, or `PRINTSTREAM_DEV_SLICER=remote`:** don't run a local slicer (BambuStudio is
 *     x86-only). The API uses `SLICER_SERVICE_URL` as-is — point it at a reachable x86 slicer
 *     (e.g. staging) in `.env`.
 */
import { spawnSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const forceRemote = (process.env.PRINTSTREAM_DEV_SLICER || '').toLowerCase() === 'remote'
const runLocalSlicer = !forceRemote && process.arch === 'x64'
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
  runSync('node', ['scripts/dev/setup-slicer.mjs']) // idempotent first-run bootstrap
  slicerEnv = {
    SLICER_SERVICE_URL: 'http://localhost:4010',
    SLICER_TARGETS_FILE: path.join(DATA_ROOT, 'slicers', 'targets.json'),
    SLICER_WORK_DIR: process.env.SLICER_WORK_DIR || '/tmp/printstream-slicer',
    SLICER_PORT: process.env.SLICER_PORT || '4010'
  }
} else {
  const why = forceRemote ? 'PRINTSTREAM_DEV_SLICER=remote' : `arch=${process.arch} (BambuStudio is x86-only)`
  console.log(`[dev] slicer: not running locally (${why}). The API uses SLICER_SERVICE_URL=${process.env.SLICER_SERVICE_URL || '(unset)'} — point it at a reachable x86 slicer.`)
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
child.on('exit', (code) => process.exit(code ?? 0))
