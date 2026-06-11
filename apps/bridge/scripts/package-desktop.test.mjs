import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computePackagingPlan } from './package-desktop.mjs'

test('computePackagingPlan exposes Linux targets supported by the current host toolset', () => {
  const plan = computePackagingPlan({
    platform: 'linux',
    arch: 'arm64',
    availableCommands: new Set(['dpkg'])
  })

  assert.deepEqual(plan.linuxTargets, ['tar.gz', 'deb'])
  assert.deepEqual(plan.windowsTargets, [])
  assert.deepEqual(plan.macTargets, [])
  assert.match(plan.warnings.join('\n'), /AppImage/)
  assert.match(plan.warnings.join('\n'), /Windows output because wine is not installed/)
  assert.match(plan.unsupported.join('\n'), /macOS host/)
})

test('computePackagingPlan enables AppImage and Windows targets when Linux host tools exist', () => {
  const plan = computePackagingPlan({
    platform: 'linux',
    arch: 'x64',
    availableCommands: new Set(['dpkg', 'wine', 'makensis', 'xorriso', 'mksquashfs'])
  })

  assert.deepEqual(plan.linuxTargets, ['AppImage', 'tar.gz', 'deb'])
  assert.deepEqual(plan.windowsTargets, ['portable', 'nsis'])
})

test('computePackagingPlan only enables mac targets on macOS hosts', () => {
  const plan = computePackagingPlan({
    platform: 'darwin',
    arch: 'arm64',
    availableCommands: new Set()
  })

  assert.deepEqual(plan.macTargets, ['zip', 'dmg'])
  assert.deepEqual(plan.windowsTargets, [])
  assert.deepEqual(plan.linuxTargets, ['tar.gz'])
})

test('computePackagingPlan preserves requested target architecture in the plan output', () => {
  const plan = computePackagingPlan({
    platform: 'linux',
    arch: 'arm64',
    availableCommands: new Set(['dpkg', 'wine', 'makensis'])
  })

  assert.equal(plan.arch, 'arm64')
  assert.deepEqual(plan.windowsTargets, ['portable', 'nsis'])
})