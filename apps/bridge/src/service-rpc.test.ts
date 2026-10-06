import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleBackupRpc } from './backup-rpc.js'
import { handleDebugCaptureRpc } from './debug-capture-rpc.js'

test('backup RPC validates its method boundary before starting work', async () => {
  assert.deepEqual(await handleBackupRpc('debug.capture.read', {}), { handled: false })
  await assert.rejects(handleBackupRpc('bridge.backup.run', null))
})

test('debug capture RPC validates input and returns start, stop, and read results', () => {
  assert.deepEqual(handleDebugCaptureRpc('bridge.backup.run', {}), { handled: false })
  assert.throws(() => handleDebugCaptureRpc('debug.capture.start', { maxFrames: -1 }))

  const started = handleDebugCaptureRpc('debug.capture.start', {})
  assert.equal(started.handled, true)
  if (!started.handled) return
  assert.equal((started.result as { active: boolean }).active, true)

  const stopped = handleDebugCaptureRpc('debug.capture.stop', {})
  assert.equal(stopped.handled, true)
  if (!stopped.handled) return
  assert.equal((stopped.result as { active: boolean }).active, false)

  const read = handleDebugCaptureRpc('debug.capture.read', {})
  assert.equal(read.handled, true)
  if (!read.handled) return
  assert.ok(Array.isArray((read.result as { frames: unknown[] }).frames))
})
