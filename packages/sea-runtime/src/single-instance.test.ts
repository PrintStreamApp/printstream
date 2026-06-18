process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { acquireSingleInstanceLock } from './single-instance.js'

let dir: string | null = null
function lockPath(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'bridge-lock-'))
  return path.join(dir, 'bridge.lock')
}

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
})

test('claims a free lock and records this pid', () => {
  const lock = lockPath()
  assert.equal(acquireSingleInstanceLock(lock), true)
  assert.equal(existsSync(lock), true)
  assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid))
})

test('refuses when a live process already holds the lock', () => {
  const lock = lockPath()
  // The parent process is alive and is not us.
  writeFileSync(lock, String(process.ppid))
  assert.equal(acquireSingleInstanceLock(lock), false)
})

test('reclaims a lock orphaned by a dead process', () => {
  const lock = lockPath()
  writeFileSync(lock, '2147483646') // implausible pid: not a running process
  assert.equal(acquireSingleInstanceLock(lock), true)
  assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid))
})
