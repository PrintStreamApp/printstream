process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { healthRouter } from './health.js'

let server: Server | null = null

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve()
      return
    }
    server.close((error) => {
      server = null
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

test('health route exposes a runtime fingerprint outside production', async () => {
  const app = express()
  app.use('/api/health', healthRouter)
  server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, '127.0.0.1', () => resolve(nextServer))
  })
  const { port } = server.address() as AddressInfo

  const response = await fetch(`http://127.0.0.1:${port}/api/health`)
  const json = await response.json() as {
    ok: boolean
    time: string
    runtime?: {
      nodeEnv: string
      bootId: string
      startedAt: string
      uptimeSeconds: number
    }
  }

  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
  assert.match(json.time, /^\d{4}-\d{2}-\d{2}T/)
  assert.notEqual(json.runtime?.nodeEnv, 'production')
  assert.match(json.runtime?.bootId ?? '', /^[a-f0-9]{8}$/)
  assert.match(json.runtime?.startedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(typeof json.runtime?.uptimeSeconds, 'number')
})