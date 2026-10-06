import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'
import { registerEngineRoutes } from './engine-routes.js'

test('unknown engine install requests stop at the catalogue gate', async () => {
  const app = express()
  registerEngineRoutes(app)

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })

  try {
    const address = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/engines/not-a-target/install`, {
      method: 'POST'
    })

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), {
      error: 'No installable engine named not-a-target on this platform.'
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})
