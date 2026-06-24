import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// The sysroot builder ships as a standalone ESM script run at image-build time (and in dev),
// so it is imported here by relative path rather than through the package entrypoint.
// @ts-expect-error - untyped sibling ESM script
import { APT_PACKAGES, APT_SUITE, UBUNTU_BASE_URL, buildX86Sysroot, sysrootStamp } from '../docker/build-x86-sysroot.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

test('the x86 sysroot closure includes the libraries the BambuStudio CLI needs under qemu', () => {
  assert.ok(Array.isArray(APT_PACKAGES) && APT_PACKAGES.length > 0)
  // These are the load-bearing pieces: drop the GTK/WebKit toolkit and the CLI fails to start;
  // drop the Mesa DRI/llvmpipe driver and slicing still works but produces thumbnail-less output
  // (the offscreen GL that renders plate previews has no software rasteriser). Guard them both.
  for (const required of ['libgtk-3-0t64', 'libwebkit2gtk-4.1-0', 'libgl1-mesa-dri', 'libegl1']) {
    assert.ok(APT_PACKAGES.includes(required), `expected APT_PACKAGES to include ${required}`)
  }
})

test('the Ubuntu base rootfs matches the apt suite and is the amd64 build', () => {
  assert.equal(typeof APT_SUITE, 'string')
  assert.match(UBUNTU_BASE_URL, /amd64/)
  // The base rootfs release must line up with the suite the closure is resolved against
  // (noble = 24.04); a mismatch mixes glibc/ABI versions in the sysroot.
  assert.match(UBUNTU_BASE_URL, /24\.04/)
})

test('buildX86Sysroot is callable and stamps inside the sysroot', () => {
  assert.equal(typeof buildX86Sysroot, 'function')
  assert.equal(sysrootStamp('/opt/x'), path.join('/opt/x', '.printstream-sysroot-ready'))
})

test('the module runs as a CLI when invoked directly (the Dockerfile relies on this)', async () => {
  // The arm64 image builds the sysroot via `node build-x86-sysroot.mjs <sysroot> <cacheDir>`.
  // Without the run-as-main guard the script only exports and silently no-ops, producing an
  // empty sysroot and a slicer that cannot load the x86-64 binary at runtime.
  const source = await readFile(path.join(repoRoot, 'apps/slicer/docker/build-x86-sysroot.mjs'), 'utf8')
  assert.match(source, /process\.argv\[1\]/)
  assert.match(source, /import\.meta\.url/)
})

test('the unified launcher handles both the native x86 and the emulated arm64 path', async () => {
  const launcher = await readFile(path.join(repoRoot, 'apps/slicer/docker/bambu-studio-cli.sh'), 'utf8')
  // Native branch: exec the AppImage's AppRun.
  assert.match(launcher, /AppRun/)
  // Emulated branch: run the bundled binary under qemu against the sysroot.
  assert.match(launcher, /qemu-x86_64-static/)
  assert.match(launcher, /QEMU_LD_PREFIX/)
  assert.match(launcher, /SLICER_QEMU_SYSROOT/)
})

test('dev qemu setup reuses the shared sysroot builder rather than duplicating the closure', async () => {
  const setup = await readFile(path.join(repoRoot, 'scripts/dev/setup-slicer-qemu.mjs'), 'utf8')
  assert.match(setup, /build-x86-sysroot\.mjs/)
  assert.match(setup, /buildX86Sysroot/)
  // It must not re-declare its own copy of the package closure (the regression this guards).
  assert.doesNotMatch(setup, /const APT_PACKAGES\s*=/)
})
