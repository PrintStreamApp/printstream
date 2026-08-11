#!/usr/bin/env node
/**
 * Build an x86-64 glibc sysroot for running the bundled (x86-only) BambuStudio CLI
 * under qemu-user emulation on a non-x86 host.
 *
 * BambuStudio ships x86-64 binaries only. On arm64 there is no native slicer, so both
 * the dev workflow (scripts/dev/setup-slicer-qemu.mjs) and the arm64 production image
 * (apps/slicer/Dockerfile) run the same x86-64 CLI through `qemu-x86_64-static` against
 * an x86-64 sysroot this module produces:
 *
 *   1. An Ubuntu base rootfs supplies a coherent x86-64 glibc + loader + base /etc.
 *   2. The GTK / WebKit / GStreamer / Mesa runtime closure the CLI links is resolved and
 *      downloaded by apt (arch-agnostic: only install-time maintainer scripts would need
 *      execution, which we skip) and unpacked with `dpkg-deb -x` — no foreign-arch dpkg
 *      install, so this runs unchanged on an arm64 host.
 *
 * The launcher (apps/slicer/docker/bambu-studio-cli.sh) then points `QEMU_LD_PREFIX` at
 * the produced sysroot. Keeping the package closure and the Ubuntu base in one place keeps
 * dev and the production image byte-for-byte identical in what they emulate against.
 *
 * Idempotent: skips the rebuild when a populated sysroot is present whose ready stamp carries
 * the current SYSROOT_REVISION; a closure change bumps the revision and forces a rebuild.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Ubuntu base rootfs supplies a coherent x86-64 glibc + loader + base config the CLI's libs need.
export const UBUNTU_BASE_URL =
  process.env.SLICER_QEMU_UBUNTU_BASE_URL ||
  'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.4-base-amd64.tar.gz'

// Ubuntu 24.04 (noble) — matches the default target's ubuntu-24.04 AppImage glibc.
export const APT_SUITE = 'noble'

// Top-level runtime packages the BambuStudio CLI links; apt pulls the full transitive closure.
//
// Mesa appears twice, for two different GL paths:
// - libgl1-mesa-dri (llvmpipe/gallium) backs the generic software GL the CLI's GTK side may touch.
// - libosmesa6 backs the OFFSCREEN context the CLI's thumbnail renderer explicitly asks GLFW for
//   (GLFW_OSMESA_CONTEXT_API on Linux). Together with a headless Wayland compositor and the
//   gl-osmesa-shim preload — both provided by bambu-studio-cli.sh — this is what lets a headless
//   slice render real plate thumbnails into its output. Each piece degrades gracefully when
//   missing: the CLI skips thumbnail generation (slicing is unaffected) and the service backfills
//   covers from the input 3MF (`backfillPlateThumbnails`; editor saves bake their own previews via
//   `embedPlateThumbnails`). `trimSysrootForHeadlessSlicing` drops the whole GL stack on purpose —
//   see it for what goes and the trade.
export const APT_PACKAGES = [
  'libgtk-3-0t64', 'libwebkit2gtk-4.1-0', 'libgstreamer1.0-0', 'libgstreamer-plugins-base1.0-0',
  'libgl1', 'libglx-mesa0', 'libgl1-mesa-dri', 'libegl1', 'libegl-mesa0', 'libgbm1', 'libglu1-mesa',
  'libosmesa6',
  'libx11-6', 'libcairo2', 'libdbus-1-3', 'libdrm2', 'libfontconfig1', 'libgdk-pixbuf-2.0-0',
  'libglib2.0-0t64', 'libpango-1.0-0', 'libpangocairo-1.0-0', 'libpangoft2-1.0-0',
  'libwayland-client0', 'libwayland-server0', 'libwayland-egl1', 'libgomp1', 'libxcb1'
]

// Bumped whenever the closure above (or the base rootfs) changes shape. Written into the ready
// stamp so an already-populated sysroot from before the change is rebuilt instead of silently
// reused — the stamp used to be existence-only, which pinned dev/native sysroots to whatever
// closure they were first built with.
export const SYSROOT_REVISION = 2

/**
 * Build (or reuse) an x86-64 sysroot at `sysroot`, caching downloads under `cacheDir`.
 * `log` defaults to console.log; pass a prefixing logger to match a caller's output style.
 */
export function buildX86Sysroot({ sysroot, cacheDir, log = console.log } = {}) {
  if (!sysroot) throw new Error('buildX86Sysroot: sysroot is required')
  if (!cacheDir) throw new Error('buildX86Sysroot: cacheDir is required')

  if (existsSync(path.join(sysroot, 'lib64/ld-linux-x86-64.so.2')) && sysrootStampIsCurrent(sysroot)) {
    log(`sysroot present (${sysroot}); skipping rebuild.`)
    return sysroot
  }
  log(`building x86-64 sysroot at ${sysroot}`)
  rmSync(sysroot, { recursive: true, force: true })
  mkdirSync(sysroot, { recursive: true })

  // 1) Ubuntu base rootfs (coherent glibc + loader + base /etc).
  const baseTar = path.join(cacheDir, 'ubuntu-base-amd64.tar.gz')
  mkdirSync(path.dirname(baseTar), { recursive: true })
  if (!existsSync(baseTar)) {
    log('  downloading Ubuntu base rootfs')
    run('curl', ['-fSL', '-o', baseTar, UBUNTU_BASE_URL])
  }
  run('tar', ['-xzf', baseTar, '-C', sysroot])

  // 2) Overlay the GTK/WebKit/GStreamer/Mesa runtime closure (download-only, then unpack).
  const aptDir = path.join(cacheDir, 'apt-amd64')
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
  log('  apt-get update (amd64 index)')
  run('apt-get', [...aptOpts, 'update'])
  log('  downloading amd64 runtime closure')
  run('apt-get', [...aptOpts, 'install', '-y', '--download-only', '--no-install-recommends', ...APT_PACKAGES])
  const debs = execFileSync('sh', ['-c', `ls ${archives}/*.deb`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  log(`  unpacking ${debs.length} packages into the sysroot`)
  for (const deb of debs) run('dpkg-deb', ['-x', deb, sysroot])
  writeFileSync(sysrootStamp(sysroot), `revision=${SYSROOT_REVISION}\n${new Date().toISOString()}\n`)
  return sysroot
}

function sysrootStampIsCurrent(sysroot) {
  try {
    return readFileSync(sysrootStamp(sysroot), 'utf8').startsWith(`revision=${SYSROOT_REVISION}\n`)
  } catch {
    return false
  }
}

/**
 * Strip a built sysroot down to what a HEADLESS slice actually loads.
 *
 * Measured on the real closure: `bin/bambu-studio` needs 131 sonames, 128 of which come from
 * here (the AppImage bundles only libavcodec/libavutil/libswscale). Every one of those is
 * DT_NEEDED and stays. What goes is everything the loader never opens:
 *
 * - The GL stack behind thumbnail rendering: Mesa's software rasteriser — `libLLVM.so` (137 MB)
 *   and `libgallium*.so` (41 MB) — plus `libOSMesa` (which needs libLLVM anyway). The native app
 *   therefore ships without CLI thumbnail rendering, a deliberate trade against a ~180 MB
 *   customer download; its outputs keep covers via the input-backfill path instead. See the note
 *   on APT_PACKAGES.
 * - GTK furniture that no headless process reads: icon themes (46 MB), locales (23 MB), docs
 *   and man pages (16 MB).
 * - Executables: `usr/bin`, `usr/sbin`, systemd and apt. We need libraries and the loader; the
 *   CLI comes from the AppImage.
 *
 * 620 MB -> 314 MB, and the trimmed sysroot slices (verified end to end under qemu).
 *
 * **Opt-in.** The Docker images keep the full sysroot: this exists for the native self-hosted
 * app, which downloads it over a customer's connection, and changing what the images emulate
 * against is a separate decision with its own blast radius.
 */
export function trimSysrootForHeadlessSlicing(sysroot, { log = console.log } = {}) {
  const before = duMegabytes(sysroot)
  for (const relative of [
    'usr/share/icons', 'usr/share/locale', 'usr/share/doc', 'usr/share/man',
    'usr/bin', 'usr/sbin', 'usr/lib/systemd', 'usr/lib/apt', 'var',
    'usr/lib/x86_64-linux-gnu/dri'
  ]) {
    rmSync(path.join(sysroot, relative), { recursive: true, force: true })
  }
  for (const glob of ['libLLVM.so*', 'libgallium*.so*', 'libOSMesa*', 'libvulkan*', 'libVkLayer*']) {
    run('sh', ['-c', `rm -f ${path.join(sysroot, 'usr/lib/x86_64-linux-gnu', glob)}`])
  }
  const after = duMegabytes(sysroot)
  log(`  trimmed sysroot ${before} MB -> ${after} MB`)
  return sysroot
}

function duMegabytes(dir) {
  const out = execFileSync('du', ['-sm', '--count-links', dir], { encoding: 'utf8' })
  return Number.parseInt(out.trim().split(/\s+/)[0] ?? '0', 10)
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
  // trusted=yes: download-only mirror access for a throwaway build sysroot; nothing is installed.
  const mirror = 'http://archive.ubuntu.com/ubuntu'
  writeFileSync(
    path.join(aptDir, 'etc/apt/sources.list'),
    [`${APT_SUITE} main universe`, `${APT_SUITE}-updates main universe`, `${APT_SUITE}-security main universe`]
      .map((suite) => `deb [arch=amd64 trusted=yes] ${mirror} ${suite}`)
      .join('\n') + '\n'
  )
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`)
  }
}

export function sysrootStamp(sysroot) {
  return path.join(sysroot, '.printstream-sysroot-ready')
}

// Run as a CLI when invoked directly (not when imported) — this is how the arm64
// production image builds the sysroot: `node build-x86-sysroot.mjs <sysroot> <cacheDir>`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sysroot = process.argv[2]
  const cacheDir = process.argv[3]
  if (!sysroot || !cacheDir) {
    console.error('Usage: build-x86-sysroot.mjs <sysroot> <cacheDir>')
    process.exit(2)
  }
  buildX86Sysroot({ sysroot, cacheDir })
}
