#!/usr/bin/env node
/**
 * Dev bootstrap for running the slicer INSIDE the workspace container on arm64
 * (Windows on ARM / WSL, Apple silicon, or any non-x86 dev host).
 *
 * BambuStudio ships x86-64 binaries only, so on arm64 there is no native slicer. Rather than
 * forcing every arm64 dev onto a remote x86 slicer, this builds an x86-64 emulation environment
 * and runs the bundled BambuStudio CLI under qemu-user:
 *
 *   1. Build an x86-64 glibc sysroot (<data>/x86root): an Ubuntu base rootfs overlaid with the
 *      GTK / WebKit / GStreamer / Mesa runtime the CLI links. apt resolves + downloads the amd64
 *      closure (arch-agnostic — only install-time maintainer scripts need execution, which we
 *      skip); the .debs are unpacked with `dpkg-deb -x`, no foreign-arch dpkg install.
 *   2. Download + extract the default BambuStudio AppImage and flatten its profiles (shared with
 *      the x86 path via generate-bambustudio-full-profiles.mjs).
 *   3. Point a slicer target's cliPath at scripts/dev/slicer-cli-qemu.sh, which execs the x86-64
 *      bin/bambu-studio through `qemu-x86_64-static -L <sysroot>` under Xvfb.
 *
 * qemu-user-static + xvfb are baked into the arm64 devcontainer image (.devcontainer/Dockerfile);
 * everything heavy this script produces lands in the persistent slicer data volume, so it only
 * runs the downloads once. Idempotent (skips populated outputs). On x86 this is never invoked —
 * scripts/dev/setup-slicer.mjs uses the native AppImage path there.
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA_ROOT = process.env.SLICER_DATA_ROOT || '/home/node/.printstream-slicer'
const SYSROOT = process.env.SLICER_QEMU_SYSROOT || path.join(DATA_ROOT, 'x86root')
const INSTALL_ROOT = path.join(DATA_ROOT, 'slicers')
const TARGETS_FILE = path.join(INSTALL_ROOT, 'targets.json')
const CLI_WRAPPER_SRC = path.join(repoRoot, 'scripts/dev/slicer-cli-qemu.sh')
const CLI_WRAPPER = path.join(DATA_ROOT, 'slicer-cli-qemu.sh')

// Ubuntu base rootfs supplies a coherent x86-64 glibc + loader + base config the CLI's libs need.
const UBUNTU_BASE_URL =
  process.env.SLICER_QEMU_UBUNTU_BASE_URL ||
  'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.4-base-amd64.tar.gz'
// Ubuntu 24.04 (noble) — matches the default target's ubuntu-24.04 AppImage glibc.
const APT_SUITE = 'noble'
// Top-level runtime packages the BambuStudio CLI links; apt pulls the full transitive closure.
const APT_PACKAGES = [
  'libgtk-3-0t64', 'libwebkit2gtk-4.1-0', 'libgstreamer1.0-0', 'libgstreamer-plugins-base1.0-0',
  'libgl1', 'libglx-mesa0', 'libgl1-mesa-dri', 'libegl1', 'libegl-mesa0', 'libgbm1', 'libglu1-mesa',
  'libx11-6', 'libcairo2', 'libdbus-1-3', 'libdrm2', 'libfontconfig1', 'libgdk-pixbuf-2.0-0',
  'libglib2.0-0t64', 'libpango-1.0-0', 'libpangocairo-1.0-0', 'libpangoft2-1.0-0',
  'libwayland-client0', 'libwayland-server0', 'libwayland-egl1', 'libgomp1', 'libxcb1'
]

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

if (existsSync(TARGETS_FILE) && existsSync(path.join(SYSROOT, 'lib64/ld-linux-x86-64.so.2'))) {
  console.log(`[setup-slicer-qemu] already populated (${TARGETS_FILE}); skipping. Remove ${DATA_ROOT} to re-bootstrap.`)
  process.exit(0)
}

console.log('[setup-slicer-qemu] First-run bootstrap (several minutes; persists in the slicer volume).')

buildSysroot()
const targetRoot = path.join(INSTALL_ROOT, target.id)
const appDir = path.join(targetRoot, 'app')
const profileDir = path.join(targetRoot, 'profiles')
await installAppImage()
installWrapper()
writeTargets({ appDir, profileDir })
console.log(`[setup-slicer-qemu] done. SLICER_TARGETS_FILE=${TARGETS_FILE}`)

function buildSysroot() {
  if (existsSync(path.join(SYSROOT, 'lib64/ld-linux-x86-64.so.2')) && existsSync(sysrootStamp())) {
    console.log(`[setup-slicer-qemu] sysroot present (${SYSROOT}); skipping rebuild.`)
    return
  }
  console.log(`[setup-slicer-qemu] building x86-64 sysroot at ${SYSROOT}`)
  rmSync(SYSROOT, { recursive: true, force: true })
  mkdirSync(SYSROOT, { recursive: true })

  // 1) Ubuntu base rootfs (coherent glibc + loader + base /etc).
  const baseTar = path.join(DATA_ROOT, 'cache', 'ubuntu-base-amd64.tar.gz')
  mkdirSync(path.dirname(baseTar), { recursive: true })
  if (!existsSync(baseTar)) {
    console.log('[setup-slicer-qemu]   downloading Ubuntu base rootfs')
    run('curl', ['-fSL', '-o', baseTar, UBUNTU_BASE_URL])
  }
  run('tar', ['-xzf', baseTar, '-C', SYSROOT])

  // 2) Overlay the GTK/WebKit/GStreamer/Mesa runtime closure (download-only, then unpack).
  const aptDir = path.join(DATA_ROOT, 'cache', 'apt-amd64')
  const archives = path.join(aptDir, 'var/cache/apt/archives')
  setupAptRoot(aptDir)
  const aptOpts = [
    `-o`, `Dir::Etc=${aptDir}/etc/apt`,
    `-o`, `Dir::State=${aptDir}/var/lib/apt`,
    `-o`, `Dir::Cache=${aptDir}/var/cache/apt`,
    `-o`, `Dir::Cache::archives=${archives}`,
    `-o`, `Dir::State::status=${aptDir}/var/lib/dpkg/status`,
    `-o`, `APT::Architecture=amd64`,
    `-o`, `APT::Architectures=amd64`,
    `-o`, `Acquire::Languages=none`
  ]
  console.log('[setup-slicer-qemu]   apt-get update (amd64 index)')
  run('apt-get', [...aptOpts, 'update'])
  console.log('[setup-slicer-qemu]   downloading amd64 runtime closure')
  run('apt-get', [...aptOpts, 'install', '-y', '--download-only', '--no-install-recommends', ...APT_PACKAGES])
  const debs = execFileSync('sh', ['-c', `ls ${archives}/*.deb`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  console.log(`[setup-slicer-qemu]   unpacking ${debs.length} packages into the sysroot`)
  for (const deb of debs) run('dpkg-deb', ['-x', deb, SYSROOT])
  writeFileSync(sysrootStamp(), `${new Date().toISOString()}\n`)
}

function setupAptRoot(aptDir) {
  for (const dir of [
    'etc/apt/preferences.d', 'etc/apt/apt.conf.d', 'etc/apt/trusted.gpg.d',
    'var/lib/apt/lists/partial', 'var/cache/apt/archives/partial', 'var/lib/dpkg'
  ]) {
    mkdirSync(path.join(aptDir, dir), { recursive: true })
  }
  // Empty dpkg status => apt resolves the full closure (incl. libc6) for a self-contained sysroot.
  writeFileSync(path.join(aptDir, 'var/lib/dpkg/status'), '')
  // trusted=yes: download-only mirror access for a throwaway dev sysroot; nothing is installed.
  const mirror = 'http://archive.ubuntu.com/ubuntu'
  writeFileSync(
    path.join(aptDir, 'etc/apt/sources.list'),
    [`${APT_SUITE} main universe`, `${APT_SUITE}-updates main universe`, `${APT_SUITE}-security main universe`]
      .map((suite) => `deb [arch=amd64 trusted=yes] ${mirror} ${suite}`)
      .join('\n') + '\n'
  )
}

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

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`)
  }
}

function hasCommand(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}

function sysrootStamp() { return path.join(SYSROOT, '.printstream-sysroot-ready') }
function targetRootOf() { return path.join(INSTALL_ROOT, target.id) }
function appDirOf() { return path.join(targetRootOf(), 'app') }
function profileDirOf() { return path.join(targetRootOf(), 'profiles') }
