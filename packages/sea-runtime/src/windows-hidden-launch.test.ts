import assert from 'node:assert/strict'
import { test } from 'node:test'
import { windowsVbsCommandLiteral } from './windows-hidden-launch.js'
import { buildWindowsCleanupLauncher } from './windows-cleanup-bootstrap.js'

test('hidden launch preserves existing tray argv and quotes separate space, empty and quote arguments', () => {
  assert.equal(windowsVbsCommandLiteral('C:\\Program Files\\app.exe', ['tray', 'run']),
    '"""C:\\Program Files\\app.exe"" tray run"')
  assert.equal(windowsVbsCommandLiteral('C:\\app.exe', ['two words', '', 'say"hello', 'C:\\space dir\\']),
    '"""C:\\app.exe"" ""two words"" """" ""say\\""hello"" ""C:\\space dir\\\\"""')
})

test('hidden launch refuses control characters and oversized native argv', () => {
  for (const argument of ['line\nbreak', 'line\rbreak', 'nul\0byte']) {
    assert.throws(() => windowsVbsCommandLiteral('C:\\app.exe', [argument]), /control characters/)
  }
  assert.throws(() => windowsVbsCommandLiteral('C:\\app.exe', ['x'.repeat(32767)]), /native limit/)
})

test('waiting cleanup handoff carries its exact trampoline then retires only its own outside bootstrap', () => {
  const directory = 'C:\\Program Files\\.sea-cleanup-owned'
  const script = `& ([ScriptBlock]::Create([IO.File]::ReadAllText('${directory}\\cleanup.ps1')))`
  const launcher = buildWindowsCleanupLauncher(script, directory)
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(launcher)?.[1]
  assert.ok(encoded)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)
  assert.match(launcher, /Run\(.*0, True\)/)
  assert.ok(launcher.indexOf('DeleteFolder') > launcher.indexOf('Run('))
  assert.ok(launcher.includes(`DeleteFolder "${directory}", True`))
  assert.doesNotMatch(launcher, /-File|ExecutionPolicy/)
  assert.throws(() => buildWindowsCleanupLauncher(script, 'C:\\Apps\\bad\nline'), /control characters/)
})
