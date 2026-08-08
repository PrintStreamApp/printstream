process.env.NODE_ENV = 'test'

/**
 * What a host is offered, and what it must never be offered.
 *
 * The pins are generated, so these do not re-check the data — they check the
 * rules layered over it, each of which has a wrong answer that looks right:
 * offering a beta as the default, offering x86-64 artifacts to an ARM Linux host
 * that cannot run them, or letting the two lists of engines drift apart.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assetPlatformKey, findCatalogueEngine, latestStableEngine, listCatalogue, needsSharedSysroot, configuredSharedRuntime } from './catalogue.js'

test('every offered engine carries a pinned artifact', () => {
  for (const platform of [['win32', 'x64'], ['linux', 'x64']] as const) {
    const engines = listCatalogue(platform[0], platform[1])
    assert.ok(engines.length > 0, `${platform.join('-')} should offer engines`)
    for (const engine of engines) {
      assert.match(engine.asset.sha256, /^[0-9a-f]{64}$/, `${engine.id} needs a real checksum`)
      assert.ok(engine.asset.bytes > 1_000_000, `${engine.id} download size looks wrong`)
      assert.ok(engine.asset.url.startsWith('https://github.com/bambulab/'), 'engines come from Bambu')
    }
  }
})

test('the default is the newest stable, never a beta', () => {
  const latest = latestStableEngine('linux', 'x64')
  assert.ok(latest, 'a stable engine must always be offered')
  assert.equal(latest.prerelease, false)
  // Nothing newer that is stable.
  const newerStable = listCatalogue('linux', 'x64')
    .filter((engine) => !engine.prerelease && engine.version > latest.version)
  assert.deepEqual(newerStable, [], 'latestStableEngine must actually be the latest')
})

test('betas are offered, just never as the default', () => {
  // They exist so a project saved by a beta desktop build can be sliced at all.
  const betas = listCatalogue('linux', 'x64').filter((engine) => engine.prerelease)
  assert.ok(betas.length > 0, 'betas must remain installable')
  assert.ok(betas.every((beta) => beta.id !== latestStableEngine('linux', 'x64')?.id))
})

test('Linux on ARM is offered nothing rather than something it cannot run', () => {
  assert.equal(assetPlatformKey('linux', 'arm64'), null)
  assert.deepEqual(listCatalogue('linux', 'arm64'), [])
})

test('Windows ARM takes the x64 build', () => {
  // Measured under Prism: slices from session 0 with byte-identical gcode.
  assert.equal(assetPlatformKey('win32', 'arm64'), 'win32-x64')
  assert.ok(listCatalogue('win32', 'arm64').length > 0)
})

test('only Linux needs the shared runtime closure', () => {
  // Windows portable builds carry every DLL beside the exe.
  assert.equal(needsSharedSysroot('linux'), true)
  assert.equal(needsSharedSysroot('win32'), false)
})

test('an unknown engine id resolves to nothing', () => {
  assert.equal(findCatalogueEngine('bambustudio-9-9-9-99', 'linux', 'x64'), null)
})

/**
 * The shared runtime must be readable AFTER the module loaded.
 *
 * A host can only compute `SLICER_RUNTIME_URL` once its database is up (the
 * origin comes from the installed licence key), which is necessarily later than
 * the import that would freeze a module-load snapshot. The native Linux app
 * does exactly that ordering, and reading the snapshot made every engine
 * install fail with "this deployment is not configured to fetch them" while the
 * variables were in fact set.
 */
test('configuredSharedRuntime reads variables set after this module loaded', () => {
  const previous = {
    url: process.env.SLICER_RUNTIME_URL,
    sha256: process.env.SLICER_RUNTIME_SHA256,
    bytes: process.env.SLICER_RUNTIME_BYTES
  }
  // Deliberately set here, in the test body: by now the module under test has
  // long since been imported, which is the whole point.
  process.env.SLICER_RUNTIME_URL = 'https://example.test/runtime.tar.zst'
  process.env.SLICER_RUNTIME_SHA256 = 'a'.repeat(64)
  process.env.SLICER_RUNTIME_BYTES = '1234'
  try {
    assert.deepEqual(configuredSharedRuntime(), {
      url: 'https://example.test/runtime.tar.zst',
      sha256: 'a'.repeat(64),
      bytes: 1234
    })
  } finally {
    for (const [key, value] of Object.entries({
      SLICER_RUNTIME_URL: previous.url,
      SLICER_RUNTIME_SHA256: previous.sha256,
      SLICER_RUNTIME_BYTES: previous.bytes
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('the default engine is the flagged one, never the head of the list', async () => {
  const { defaultCatalogueEngine, listCatalogue } = await import('./catalogue.js')
  const installable = listCatalogue('linux', 'x64')
  const chosen = defaultCatalogueEngine('linux', 'x64')
  assert.ok(chosen, 'linux-x64 must have an installable default')

  // The bug this pins: the pinned list is OLDEST first, and the first-run
  // install took its head — so a fresh container fetched Bambu Studio 2.6.0.51
  // instead of the current default. Caught by booting a real image, not by a
  // type error.
  assert.notEqual(chosen.id, installable[0]?.id, 'the default must not be the oldest entry')
  assert.equal(chosen.prerelease, false, 'a beta must never be the default')
  assert.equal(chosen.isDefault, true, 'the flagged target is the default')
})

test('arm64 Linux has engines in our container and none on a bare host', async () => {
  const { assetPlatformKey, listCatalogue } = await import('./catalogue.js')

  // The regression this pins: dropping the baked engines left an arm64 image
  // with nothing installable and therefore no slicing at all, while the README
  // advertises arm64 through qemu. The artifact is x86-64 either way — the
  // container is what can run it.
  assert.equal(assetPlatformKey('linux', 'arm64', 'container'), 'linux-x64')
  assert.ok(listCatalogue('linux', 'arm64', 'container').length > 0)

  // A bare ARM host genuinely cannot, and must not be offered a download it
  // could never execute.
  assert.equal(assetPlatformKey('linux', 'arm64', 'native'), null)
  assert.equal(listCatalogue('linux', 'arm64', 'native').length, 0)

  // x86-64 is unaffected by the strategy.
  for (const strategy of ['native', 'container'] as const) {
    assert.equal(assetPlatformKey('linux', 'x64', strategy), 'linux-x64')
  }
})
