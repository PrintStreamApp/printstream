process.env.NODE_ENV = 'test'

/**
 * The engine invocation, which is the whole platform-specific surface.
 *
 * The Linux shape is not obvious and was arrived at by measurement, so it is
 * pinned here: running the binary directly resolves GTK/WebKit against the HOST,
 * which is empty on a server and often the wrong ABI on a desktop. Going through
 * the sysroot's own loader is what makes the install distro-independent.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSlicerEngineCommand } from './launcher.js'

test('Windows runs the bundled executable directly', () => {
  // The portable build carries every DLL beside the exe, so there is nothing to wire.
  const command = buildSlicerEngineCommand({ appDir: 'C:\\ProgramData\\PrintStream\\engine' }, 'win32')
  assert.match(command.execute, /bambu-studio\.exe$/)
  assert.deepEqual(command.argsPrefix, [])
})

test('Linux runs through the sysroot loader, never the binary directly', () => {
  const command = buildSlicerEngineCommand(
    { appDir: '/var/lib/printstream/engine', sysrootDir: '/var/lib/printstream/sysroot' },
    'linux'
  )
  assert.equal(command.execute, '/var/lib/printstream/sysroot/lib64/ld-linux-x86-64.so.2')
  assert.equal(command.argsPrefix[0], '--library-path')
  assert.equal(command.argsPrefix.at(-1), '/var/lib/printstream/engine/bin/bambu-studio')
})

test("the AppImage's own bin comes first on the library path", () => {
  // It bundles libavcodec/libavutil/libswscale and the sysroot has none of them;
  // put the sysroot first and the engine fails to start with a missing libavcodec.
  const command = buildSlicerEngineCommand(
    { appDir: '/engine', sysrootDir: '/sysroot' },
    'linux'
  )
  const entries = command.argsPrefix[1]!.split(':')
  assert.equal(entries[0], '/engine/bin')
  assert.ok(entries.slice(1).every((entry) => entry.startsWith('/sysroot')), 'the rest resolve inside the sysroot')
})

test('no host library directory is ever on the path', () => {
  // The point of the whole arrangement: nothing outside the install is reachable.
  const command = buildSlicerEngineCommand({ appDir: '/engine', sysrootDir: '/sysroot' }, 'linux')
  for (const entry of command.argsPrefix[1]!.split(':')) {
    assert.ok(
      entry.startsWith('/engine') || entry.startsWith('/sysroot'),
      `${entry} escapes the install`
    )
  }
})

test('Linux without a sysroot is refused rather than silently using host libraries', () => {
  assert.throws(
    () => buildSlicerEngineCommand({ appDir: '/engine' }, 'linux'),
    /runtime sysroot/
  )
})
