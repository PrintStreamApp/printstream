/** Destructive retirement refuses uncertain and substituted locks without changing them. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock, test } from 'node:test'
import { assertSingleInstanceRetired } from './single-instance.js'

/** Keep every path owned by this test, including deliberately dangling links. */
function fixture(run: (lock: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sea-retirement-'))
  try { run(path.join(root, 'instance.lock')) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('retirement accepts a missing lock and a proven dead holder', () => {
  fixture(lock => {
    assert.doesNotThrow(() => assertSingleInstanceRetired(lock))
    writeFileSync(lock, '12345')
    const probe = mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    try { assert.doesNotThrow(() => assertSingleInstanceRetired(lock)) } finally { probe.mock.restore() }
    assert.equal(readFileSync(lock, 'utf8'), '12345')
  })
})

test('retirement rejects live, malformed and permission-uncertain holders without deleting the lock', () => {
  fixture(lock => {
    writeFileSync(lock, String(process.pid))
    assert.throws(() => assertSingleInstanceRetired(lock), /still active/)
    for (const value of ['', '123garbage', '-4', '1.5', '9007199254740992']) {
      writeFileSync(lock, value)
      assert.throws(() => assertSingleInstanceRetired(lock), /cannot be established/)
      assert.equal(readFileSync(lock, 'utf8'), value)
    }
    writeFileSync(lock, '12345')
    const probe = mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    try { assert.throws(() => assertSingleInstanceRetired(lock), /denied/) } finally { probe.mock.restore() }
  })
})

test('retirement rejects directory and dangling symbolic-link substitutions', () => {
  fixture(lock => {
    mkdirSync(lock)
    assert.throws(() => assertSingleInstanceRetired(lock), /Substituted/)
    rmSync(lock, { recursive: true })
    symlinkSync(path.join(path.dirname(lock), 'missing'), lock)
    assert.throws(() => assertSingleInstanceRetired(lock), /Substituted/)
  })
})
