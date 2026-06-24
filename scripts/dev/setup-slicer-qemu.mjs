#!/usr/bin/env node
/**
 * Dev bootstrap for running the slicer INSIDE the workspace container on arm64
 * (Windows on ARM / WSL, Apple silicon, or any non-x86 dev host).
 *
 * BambuStudio ships x86-64 binaries only, so on arm64 there is no native slicer. Rather than
 * forcing every arm64 dev onto a remote x86 slicer, this builds an x86-64 emulation environment
 * and runs the bundled BambuStudio CLI under qemu-user:
 *
 *   1. Build an x86-64 glibc sysroot (<data>/x86root) via the shared builder
 *      apps/slicer/docker/build-x86-sysroot.mjs — the same closure baked into the arm64
 *      production image, so dev and prod emulate against an identical sysroot.
 *   2. Download + extract the default BambuStudio AppImage and flatten its profiles (shared with
 *      the x86 path via generate-bambustudio-full-profiles.mjs).
 *   3. Point a slicer target's cliPath at the unified launcher apps/slicer/docker/bambu-studio-cli.sh,
 *      which on arm64 execs bin/bambu-studio through `qemu-x86_64-static -L <sysroot>` under Xvfb.
 *
 * qemu-user-static + xvfb are baked into the arm64 devcontainer image (.devcontainer/Dockerfile);
 * everything heavy this script produces lands in the persistent slicer data volume, so it only
 * runs the downloads once. Every step is idempotent (skips populated outputs) and the wrapper +
 * targets manifest are rewritten on each run, so an existing data volume self-heals after a
 * launcher/target change. On x86 this is never invoked — scripts/dev/setup-slicer.mjs uses the
 * native AppImage path there.
 *
 * Invoked by scripts/dev/run-dev.mjs on arm64. The slicer service then reads
 * SLICER_TARGETS_FILE=<data>/slicers/targets.json.
 */
import { createWriteStream, existsSync } from 'node:fs'
import { chmodSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { generateFullProfiles } from '../../apps/slicer/docker/generate-bambustudio-full-profiles.mjs'
import { slicerTargets } from '../../apps/slicer/docker/slicer-targets.mjs'
import { buildX86Sysroot } from '../../apps/slicer/docker/build-x86-sysroot.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA_ROOT = process.env.SLICER_DATA_ROOT || '/home/node/.printstream-slicer'
const SYSROOT = process.env.SLICER_QEMU_SYSROOT || path.join(DATA_ROOT, 'x86root')
const INSTALL_ROOT = path.join(DATA_ROOT, 'slicers')
const TARGETS_FILE = path.join(INSTALL_ROOT, 'targets.json')
// The dev cliPath is the same unified launcher the production image ships; it detects the
// arm64 host and routes through qemu-user. Copied into the data dir so it survives without a
// repo mount.
const CLI_WRAPPER_SRC = path.join(repoRoot, 'apps/slicer/docker/bambu-studio-cli.sh')
const CLI_WRAPPER = path.join(DATA_ROOT, 'bambu-studio-cli.sh')

if (process.arch === 'x64') {
  console.log('[setup-slicer-qemu] arch=x64: use scripts/dev/setup-slicer.mjs (native AppImage). Skipping.')
  process.exit(0)
}

if (!hasCommand('qemu-x86_64-static')) {
  console.error('[setup-slicer-qemu] qemu-x86_64-static not found. Rebuild the arm64 devcontainer')
  console.error('[setup-slicer-qemu] (it installs qemu-user-static + xvfb) or `apt-get install qemu-user-static`.')
  process.exit(1)
}

const target = slicerTargets.find((entry) => entry.isDefault) ?? slicerTargets[0]
if (!target) {
  console.error('[setup-slicer-qemu] no slicer targets defined in slicer-targets.mjs')
  process.exit(1)
}

console.log('[setup-slicer-qemu] ensuring slicer emulation environment (first run downloads ~400MB; persists in the slicer volume).')

buildX86Sysroot({
  sysroot: SYSROOT,
  cacheDir: path.join(DATA_ROOT, 'cache'),
  log: (message) => console.log(`[setup-slicer-qemu] ${message}`)
})
const targetRoot = path.join(INSTALL_ROOT, target.id)
const appDir = path.join(targetRoot, 'app')
const profileDir = path.join(targetRoot, 'profiles')
await installAppImage()
installWrapper()
writeTargets({ appDir, profileDir })
console.log(`[setup-slicer-qemu] done. SLICER_TARGETS_FILE=${TARGETS_FILE}`)

async function installAppImage() {
  if (existsSync(path.join(appDirOf(), 'AppRun'))) {
    console.log('[setup-slicer-qemu] AppImage already extracted; skipping download.')
  } else {
    const downloadPath = path.join(targetRootOf(), `${target.id}.AppImage`)
    mkdirSync(targetRootOf(), { recursive: true })
    console.log(`[setup-slicer-qemu] downloading ${target.label}`)
    await downloadFile(target.downloadUrl, downloadPath)
    extractAppImage(downloadPath, appDirOf())
    rmSync(downloadPath, { force: true })
  }
  if (!existsSync(path.join(profileDirOf(), 'machine_full'))) {
    console.log('[setup-slicer-qemu] flattening profiles')
    await generateFullProfiles(path.join(appDirOf(), 'resources', 'profiles'), profileDirOf())
  } else {
    console.log('[setup-slicer-qemu] profiles already generated; skipping.')
  }
}

function extractAppImage(appImagePath, appDir) {
  rmSync(appDir, { recursive: true, force: true })
  const offsets = execFileSync('grep', ['-abo', 'hsqs', appImagePath], { encoding: 'utf8' })
    .trim().split('\n').map((line) => Number(line.split(':', 1)[0])).filter(Number.isFinite)
  for (const offset of offsets) {
    if (spawnSync('unsquashfs', ['-q', '-d', appDir, '-o', String(offset), appImagePath], { stdio: 'inherit' }).status === 0) return
    rmSync(appDir, { recursive: true, force: true })
  }
  throw new Error(`Unable to extract AppImage ${appImagePath}`)
}

function installWrapper() {
  copyFileSync(CLI_WRAPPER_SRC, CLI_WRAPPER)
  chmodSync(CLI_WRAPPER, 0o755)
}

function writeTargets({ appDir, profileDir }) {
  const manifest = {
    defaultTargetId: target.id,
    targets: [{
      id: target.id,
      label: `${target.label} (arm64/qemu)`,
      family: target.family,
      version: target.version,
      slicerName: target.slicerName,
      isDefault: true,
      cliPath: CLI_WRAPPER,
      appDir,
      profileDir
    }]
  }
  writeFileSync(TARGETS_FILE, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function downloadFile(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

function hasCommand(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}

function targetRootOf() { return path.join(INSTALL_ROOT, target.id) }
function appDirOf() { return path.join(targetRootOf(), 'app') }
function profileDirOf() { return path.join(targetRootOf(), 'profiles') }
