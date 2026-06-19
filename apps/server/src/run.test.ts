import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer, type Server } from 'node:net'
import { assertPortAvailable } from './run.js'

const openServers: Server[] = []

after(async () => {
  await Promise.all(openServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function listenOnEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    openServers.push(server)
    server.once('error', reject)
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('Failed to acquire an ephemeral port'))
    })
  })
}

test('assertPortAvailable resolves for a free port', async () => {
  const port = await listenOnEphemeralPort()
  await new Promise<void>((resolve) => openServers[openServers.length - 1]!.close(() => resolve()))
  await assert.doesNotReject(() => assertPortAvailable(port))
})

test('assertPortAvailable rejects with a clear message when the port is in use', async () => {
  const port = await listenOnEphemeralPort()
  await assert.rejects(
    () => assertPortAvailable(port),
    (error: unknown) => error instanceof Error
      && /already in use/i.test(error.message)
      && error.message.includes(String(port))
  )
})
