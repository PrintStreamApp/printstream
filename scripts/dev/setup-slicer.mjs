#!/usr/bin/env node
/**
 * Dev bootstrap for running the slicer INSIDE the workspace container (x86 only).
 *
 * Mirrors the slicer image's build-time `install-slicer-targets` step, but writes into a
 * dev data dir (a named volume mounted in the workspace) instead of the image, so the
 * BambuStudio AppImage + flattened profile caches persist across devcontainer rebuilds and
 * are only fetched once. Idempotent (skips when already populated) and **arch-gated**:
 * BambuStudio is x86-only, so on arm64 (Apple silicon) this no-ops — those devs run dev
 * against a remote x86 slicer instead (set `SLICER_SERVICE_URL`; see `npm run deploy:slicer`).
 *
 * Invoked by `scripts/dev/run-dev.mjs` when `PRINTSTREAM_DEV_SLICER=workspace`. The slicer
 * service then reads `SLICER_TARGETS_FILE=<data>/targets.json`.
 */
import { existsSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA_ROOT = process.env.SLICER_DATA_ROOT || '/home/node/.printstream-slicer'
// Install into a SUBDIR of the volume, not the mount point itself: install-slicer-targets.mjs
// starts by `rm`-ing its output root, and you can't rmdir a mount point (EBUSY).
const INSTALL_ROOT = path.join(DATA_ROOT, 'slicers')
const TARGETS_FILE = path.join(INSTALL_ROOT, 'targets.json')
const installScript = path.join(repoRoot, 'apps/slicer/docker/install-slicer-targets.mjs')
const cliPath = path.join(repoRoot, 'apps/slicer/docker/bambu-studio-cli.sh')

// BambuStudio ships x86 binaries only; `process.arch` is 'x64' on amd64, 'arm64' on Apple silicon.
if (process.arch !== 'x64') {
  console.log(`[setup-slicer] arch=${process.arch}: skipping the in-workspace slicer (BambuStudio is x86-only).`)
  console.log('[setup-slicer] Point SLICER_SERVICE_URL at a remote x86 slicer (rebuilt with `npm run deploy:slicer`).')
  process.exit(0)
}

if (existsSync(TARGETS_FILE)) {
  console.log(`[setup-slicer] already populated (${TARGETS_FILE}); skipping. Remove ${DATA_ROOT} to re-bootstrap.`)
  process.exit(0)
}

console.log('[setup-slicer] First-run bootstrap: downloading the BambuStudio AppImage + generating profiles')
console.log(`[setup-slicer]   data dir: ${DATA_ROOT} (this takes several minutes; runs once and persists in the volume)`)
try {
  chmodSync(cliPath, 0o755)
} catch {
  // best-effort; the script is committed executable
}

const result = spawnSync('node', [installScript, INSTALL_ROOT, cliPath], { stdio: 'inherit' })
if (result.status !== 0) {
  console.error('[setup-slicer] bootstrap failed — the in-workspace slicer will not start. See output above.')
  process.exit(result.status ?? 1)
}
console.log(`[setup-slicer] done. SLICER_TARGETS_FILE=${TARGETS_FILE}`)
