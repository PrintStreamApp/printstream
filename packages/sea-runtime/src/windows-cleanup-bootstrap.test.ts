/** Pure bootstrap handoff tests; native ACL admission remains a separate Windows qualification. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mock, test } from 'node:test'
import { prepareWindowsCleanupBootstrap } from './windows-cleanup-bootstrap.js'

/** Execute the actual serializer/receipt validator while replacing only native process admission. */
function withBootstrap(response: (input: { directory: string; contents: string; payload: string }) => unknown,
  run: () => void): void {
  const native = mock.method(childProcess, 'spawnSync', (_command: string, _args: string[], options: { input: string }) =>
    response(JSON.parse(options.input)))
  syncBuiltinESMExports()
  try { run() } finally { native.mock.restore(); syncBuiltinESMExports() }
}

test('bootstrap moves the full payload into its admitted private directory and bounds the launcher', () => {
  const payload = '# exact Unicode payload: café\n' + 'Write-Output fixture\n'.repeat(10000)
  let admittedDirectory = ''
  withBootstrap((input) => {
    admittedDirectory = input.directory
    assert.equal(input.payload, payload)
    assert.ok(input.contents.length < 4000, 'launcher carries only the small payload-loading trampoline')
    assert.doesNotMatch(input.contents, /Write-Output fixture/)
    const encoded = input.contents.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1]
    assert.ok(encoded)
    const trampoline = Buffer.from(encoded, 'base64').toString('utf16le')
    assert.equal(trampoline, `& ([ScriptBlock]::Create([IO.File]::ReadAllText('${input.directory}\\cleanup.ps1')))`)
    assert.match(input.contents, /DeleteFolder/)
    assert.match(input.contents, /WScript.Quit exitCode/)
    return { status: 0, signal: null, stdout: JSON.stringify({ directory: input.directory, launcher: `${input.directory}\\cleanup.vbs` }) }
  }, () => {
    assert.deepEqual(prepareWindowsCleanupBootstrap(payload, 'C:\\Program Files\\owned'),
      { directory: admittedDirectory, launcher: `${admittedDirectory}\\cleanup.vbs` })
  })
})

test('bootstrap refuses a mismatched receipt instead of launching an unadmitted path', () => {
  withBootstrap((input) => ({ status: 0, signal: null, stdout: JSON.stringify({ directory: input.directory,
    launcher: 'C:\\foreign\\cleanup.vbs' }) }), () => {
    assert.throws(() => prepareWindowsCleanupBootstrap('fixture', 'C:\\Program Files\\owned'), /unexpected paths/)
  })
})

test('bootstrap native failure reveals no raw native diagnostic or partial path', () => {
  withBootstrap(() => ({ status: 1, signal: null, stdout: '', stderr: 'private partial directory' }), () => {
    assert.throws(() => prepareWindowsCleanupBootstrap('fixture', 'C:\\Program Files\\owned'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Windows cleanup bootstrap admission failed')
      return true
    })
  })
})
