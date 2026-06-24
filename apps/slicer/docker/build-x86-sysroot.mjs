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
 * Idempotent: skips the rebuild when a populated sysroot (loader + ready stamp) is present.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
// Mesa's DRI/llvmpipe driver (libgl1-mesa-dri) is required for the offscreen GL that renders
// plate thumbnails — dropping it slices gcode fine but produces thumbnail-less output.
export const APT_PACKAGES = [
  'libgtk-3-0t64', 'libwebkit2gtk-4.1-0', 'libgstreamer1.0-0', 'libgstreamer-plugins-base1.0-0',
  'libgl1', 'libglx-mesa0', 'libgl1-mesa-dri', 'libegl1', 'libegl-mesa0', 'libgbm1', 'libglu1-mesa',
  'libx11-6', 'libcairo2', 'libdbus-1-3', 'libdrm2', 'libfontconfig1', 'libgdk-pixbuf-2.0-0',
  'libglib2.0-0t64', 'libpango-1.0-0', 'libpangocairo-1.0-0', 'libpangoft2-1.0-0',
  'libwayland-client0', 'libwayland-server0', 'libwayland-egl1', 'libgomp1', 'libxcb1'
]

/**
 * Build (or reuse) an x86-64 sysroot at `sysroot`, caching downloads under `cacheDir`.
 * `log` defaults to console.log; pass a prefixing logger to match a caller's output style.
 */
export function buildX86Sysroot({ sysroot, cacheDir, log = console.log } = {}) {
  if (!sysroot) throw new Error('buildX86Sysroot: sysroot is required')
  if (!cacheDir) throw new Error('buildX86Sysroot: cacheDir is required')

  if (existsSync(path.join(sysroot, 'lib64/ld-linux-x86-64.so.2')) && existsSync(sysrootStamp(sysroot))) {
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
  writeFileSync(sysrootStamp(sysroot), `${new Date().toISOString()}\n`)
  return sysroot
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
