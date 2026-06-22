import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createKeyedMutex } from './keyed-mutex.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('same-key tasks run one at a time in arrival order', async () => {
  const mutex = createKeyedMutex()
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

  const first = mutex.run('a', async () => {
    order.push('first:start')
    await firstGate
    order.push('first:end')
  })
  const second = mutex.run('a', async () => {
    order.push('second')
  })

  await tick()
  // The second task must not have started while the first holds the key.
  assert.deepEqual(order, ['first:start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first:start', 'first:end', 'second'])
})

test('different keys run concurrently', async () => {
  const mutex = createKeyedMutex()
  const order: string[] = []
  let releaseA!: () => void
  const aGate = new Promise<void>((resolve) => { releaseA = resolve })

  const a = mutex.run('a', async () => {
    order.push('a:start')
    await aGate
    order.push('a:end')
  })
  const b = mutex.run('b', async () => {
    order.push('b')
  })

  await tick()
  // 'b' is a different key, so it runs without waiting for 'a'.
  assert.deepEqual(order, ['a:start', 'b'])
  releaseA()
  await Promise.all([a, b])
})

test('a failed task does not block the next task for the same key', async () => {
  const mutex = createKeyedMutex()
  const ran: string[] = []

  const failing = mutex.run('a', async () => { ran.push('one'); throw new Error('boom') })
  await assert.rejects(failing, /boom/)
  await mutex.run('a', async () => { ran.push('two') })

  assert.deepEqual(ran, ['one', 'two'])
})

test('run returns the task result', async () => {
  const mutex = createKeyedMutex()
  assert.equal(await mutex.run('a', async () => 42), 42)
})
