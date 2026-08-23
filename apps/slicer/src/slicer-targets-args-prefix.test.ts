process.env.NODE_ENV = 'test'

/**
 * `cliArgsPrefix` on a manifest target.
 *
 * The native Linux app cannot spawn the engine binary directly, it runs it
 * through its own sysroot's dynamic loader so GTK/WebKit resolve inside the
 * install rather than against a host that may have neither. The prefix carries
 * `--library-path … <binary>`, so it must survive the manifest parse and default
 * to empty for every target that does not need it (the containers, which spawn
 * their CLI directly).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtimeSlicerTargetsFileSchema } from './slicer-targets.js'

const base = {
  id: 'bambustudio-2-7-1-62',
  label: 'Bambu Studio 2.7.1.62',
  family: 'bambustudio' as const,
  version: '2.7.1.62',
  slicerName: 'Bambu Studio',
  supportsEstimateModeMachineSwitch: true,
  isDefault: true,
  cliPath: '/engine/cli',
  profileDir: '/engine/profiles'
}

test('a target without a prefix parses and defaults to none', () => {
  const parsed = runtimeSlicerTargetsFileSchema.parse({ defaultTargetId: base.id, targets: [base] })
  assert.deepEqual(parsed.targets[0]!.cliArgsPrefix, [], 'the container path must be unaffected')
})

test('a loader-invoked target keeps its prefix, in order', () => {
  const prefix = ['--library-path', '/engine/bin:/sysroot/lib64', '/engine/bin/bambu-studio']
  const parsed = runtimeSlicerTargetsFileSchema.parse({
    defaultTargetId: base.id,
    targets: [{ ...base, cliPath: '/sysroot/lib64/ld-linux-x86-64.so.2', cliArgsPrefix: prefix }]
  })
  // Order is load-bearing: the loader takes --library-path before the binary it runs.
  assert.deepEqual(parsed.targets[0]!.cliArgsPrefix, prefix)
})

test('a non-string prefix entry is rejected rather than coerced', () => {
  // A coerced argument would reach spawn() as "[object Object]" and the engine
  // would fail with something that names neither the manifest nor the cause.
  assert.throws(() => runtimeSlicerTargetsFileSchema.parse({
    defaultTargetId: base.id,
    targets: [{ ...base, cliArgsPrefix: ['--library-path', { path: '/sysroot' }] }]
  }))
})
