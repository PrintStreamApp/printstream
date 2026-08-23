/**
 * The control client is shared by every SEA app, so its failures must be typed
 * (callers translate them) and its wording must not name one app. A `bridge`
 * timeout message shipped in the SERVER's CLI for exactly that reason.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ControlChannelTimeoutError, ControlChannelUnavailableError, requestControl } from './control-client.js'

async function withTempSocketDir(body: (socketPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'control-client-'))
  try {
    await body(path.join(dir, 'control.sock'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A channel that accepts and then says nothing: the shape of an app that died
 * mid-operation. Accepted sockets are destroyed by hand because `net.Server` has
 * no `closeAllConnections` (that is `http.Server`), and `close()` alone waits on
 * them forever, which hangs the run rather than failing it.
 */
async function withSilentServer(socketPath: string, body: () => Promise<void>): Promise<void> {
  const accepted: Socket[] = []
  const server = createServer((socket) => accepted.push(socket))
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  try {
    await body()
  } finally {
    for (const socket of accepted) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('nothing listening rejects with the typed unavailable error', async () => {
  await withTempSocketDir(async (socketPath) => {
    await assert.rejects(requestControl(socketPath, 'status', 1000), ControlChannelUnavailableError)
  })
})

test('a channel that accepts and never answers rejects with the typed timeout error', async () => {
  await withTempSocketDir(async (socketPath) => {
    await withSilentServer(socketPath, async () => {
      await assert.rejects(requestControl(socketPath, 'update.apply', 250), ControlChannelTimeoutError)
    })
  })
})

test('no failure this package raises names a specific app', async () => {
  const messages: string[] = []

  await withTempSocketDir(async (socketPath) => {
    await requestControl(socketPath, 'status', 1000).catch((error: Error) => messages.push(error.message))

    await withSilentServer(socketPath, async () => {
      await requestControl(socketPath, 'status', 250).catch((error: Error) => messages.push(error.message))
    })
  })

  assert.equal(messages.length, 2, 'both failure paths should have produced a message')
  for (const message of messages) {
    // "bridge" and "server" are both product nouns here; a shared package saying
    // either one is wrong in the other app's CLI.
    assert.doesNotMatch(message, /bridge/i, `app-specific wording leaked: ${message}`)
    assert.doesNotMatch(message, /printstream/i, `app-specific wording leaked: ${message}`)
  }
})
