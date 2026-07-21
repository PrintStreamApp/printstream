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
 *
 * Installs EVERY engine in apps/slicer/docker/slicer-targets.mjs by default, so version-specific
 * behaviour is reproducible locally without re-provisioning (e.g. a project saved by a newer Bambu
 * Studio, which the default engine refuses outright). Each engine is a few hundred MB of download +
 * profile flattening, paid once — the step is idempotent and skips anything already extracted. Set
 * PRINTSTREAM_DEV_SLICER_TARGETS=default for just the stable default, or a comma-separated list of
 * ids, when a faster first run matters.
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

const defaultTarget = slicerTargets.find((entry) => entry.isDefault) ?? slicerTargets[0]
if (!defaultTarget) {
  console.error('[setup-slicer-qemu] no slicer targets defined in slicer-targets.mjs')
  process.exit(1)
}

// Dev installs EVERY bundled engine by default, so any version-specific behaviour is reproducible
// locally without re-provisioning — notably a project saved by a newer Bambu Studio, which the
// default engine refuses outright. The cost is paid once: each AppImage is a few hundred MB to
// download, extract and flatten profiles for. Narrow it with
// PRINTSTREAM_DEV_SLICER_TARGETS=default (just the stable default) or a comma-separated list of
// ids for a faster first run.
const requestedTargets = (process.env.PRINTSTREAM_DEV_SLICER_TARGETS ?? '').trim()
const targets = resolveRequestedTargets(requestedTargets)
console.log(`[setup-slicer-qemu] installing ${targets.length} target(s): ${targets.map((entry) => entry.id).join(', ')}`)

function resolveRequestedTargets(request) {
  if (!request || request.toLowerCase() === 'all') return slicerTargets
  if (request.toLowerCase() === 'default') return [defaultTarget]
  const wanted = request.split(',').map((value) => value.trim()).filter(Boolean)
  const resolved = []
  for (const id of wanted) {
    const match = slicerTargets.find((entry) => entry.id === id)
    if (!match) {
      console.error(`[setup-slicer-qemu] unknown target id "${id}". Known ids: ${slicerTargets.map((entry) => entry.id).join(', ')}`)
      process.exit(1)
    }
    resolved.push(match)
  }
  // Always keep the stable default installed so the manifest's defaultTargetId resolves to a
  // real install even when the request only names betas.
  if (!resolved.some((entry) => entry.id === defaultTarget.id)) resolved.unshift(defaultTarget)
  return resolved
}

console.log('[setup-slicer-qemu] ensuring slicer emulation environment (first run downloads ~400MB; persists in the slicer volume).')

buildX86Sysroot({
  sysroot: SYSROOT,
  cacheDir: path.join(DATA_ROOT, 'cache'),
  log: (message) => console.log(`[setup-slicer-qemu] ${message}`)
})
const installed = []
for (const target of targets) {
  await installAppImage(target)
  installed.push({
    target,
    appDir: appDirOf(target),
    profileDir: profileDirOf(target)
  })
}
installWrapper()
writeTargets(installed)
console.log(`[setup-slicer-qemu] done. SLICER_TARGETS_FILE=${TARGETS_FILE}`)

async function installAppImage(target) {
  if (existsSync(path.join(appDirOf(target), 'AppRun'))) {
    console.log(`[setup-slicer-qemu] ${target.id}: AppImage already extracted; skipping download.`)
  } else {
    const downloadPath = path.join(targetRootOf(target), `${target.id}.AppImage`)
    mkdirSync(targetRootOf(target), { recursive: true })
    console.log(`[setup-slicer-qemu] downloading ${target.label}`)
    await downloadFile(target.downloadUrl, downloadPath)
    extractAppImage(downloadPath, appDirOf(target))
    rmSync(downloadPath, { force: true })
  }
  if (!existsSync(path.join(profileDirOf(target), 'machine_full'))) {
    console.log(`[setup-slicer-qemu] ${target.id}: flattening profiles`)
    await generateFullProfiles(path.join(appDirOf(target), 'resources', 'profiles'), profileDirOf(target))
  } else {
    console.log(`[setup-slicer-qemu] ${target.id}: profiles already generated; skipping.`)
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

function writeTargets(entries) {
  const manifest = {
    // Mirrors the production installer: never let a beta be the default, even if one was the only
    // thing explicitly requested (the stable default is always installed alongside).
    defaultTargetId: (entries.find(({ target }) => target.id === defaultTarget.id) ?? entries[0]).target.id,
    targets: entries.map(({ target, appDir, profileDir }) => ({
      id: target.id,
      label: `${target.label} (arm64/qemu)`,
      family: target.family,
      version: target.version,
      slicerName: target.slicerName,
      isDefault: target.id === defaultTarget.id,
      prerelease: target.prerelease === true,
      cliPath: CLI_WRAPPER,
      appDir,
      profileDir
    }))
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

function targetRootOf(target) { return path.join(INSTALL_ROOT, target.id) }
function appDirOf(target) { return path.join(targetRootOf(target), 'app') }
function profileDirOf(target) { return path.join(targetRootOf(target), 'profiles') }
