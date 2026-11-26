/** Conditional bootstrap admission follows physical overlap, including missing leaves. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mock, test } from 'node:test'
import { withWindowsInstallDataWrite } from './windows-install-data-write.js'

/** Only native process and realpath boundaries are replaced; actual containment and admission execute. */
function withPaths(resolve: (value: string) => string, run: (calls: string[]) => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const calls: string[] = []
  const physical = mock.method(fs.realpathSync, 'native', resolve)
  const native = mock.method(childProcess, 'spawnSync', (_command: string, _args: string[], options: { input: string }) => {
    const request = JSON.parse(options.input) as { action: string; installDir: string }
    calls.push(request.action)
    const directory = 'C:\\.sea-operation-fixture'
    return { status: 0, signal: null, stdout: JSON.stringify({ directory, claim: `${directory}\\active.json`, installDir: request.installDir }) }
  })
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  syncBuiltinESMExports()
  try { run(calls) } finally {
    Object.defineProperty(process, 'platform', platform)
    physical.mock.restore()
    native.mock.restore()
    syncBuiltinESMExports()
  }
}

for (const [name, data, owns] of [
  ['nested', 'C:\\App\\data', true], ['equal', 'C:\\App', true],
  ['ancestor', 'C:\\', true], ['separate sibling', 'C:\\AppData', false],
  ['separate drive', 'D:\\App', false],
] as const) {
  test(`DATA ${name} uses the expected finite installation boundary`, () => {
    withPaths(value => value, calls => {
      assert.equal(withWindowsInstallDataWrite('C:\\App\\app.exe', data, () => {
        assert.deepEqual(calls, owns ? ['acquire'] : [])
        return 42
      }), 42)
      assert.deepEqual(calls, owns ? ['acquire', 'release'] : [])
    })
  })
}

test('DATA physical aliases and missing descendant leaves still acquire admission', () => {
  withPaths(value => {
    if (value === 'C:\\SHORT\\new') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return value === 'C:\\SHORT' ? 'C:\\App\\data' : value
  }, calls => {
    withWindowsInstallDataWrite('C:\\App\\app.exe', 'C:\\SHORT\\new', () => { assert.deepEqual(calls, ['acquire']) })
    assert.deepEqual(calls, ['acquire', 'release'])
  })
})

test('DATA physical-resolution failure prevents bootstrap mutation', () => {
  let mutated = false
  withPaths(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }, calls => {
    assert.throws(() => withWindowsInstallDataWrite('C:\\App\\app.exe', 'C:\\App\\data', () => { mutated = true }), /denied/)
    assert.equal(mutated, false)
    assert.deepEqual(calls, [])
  })
})
