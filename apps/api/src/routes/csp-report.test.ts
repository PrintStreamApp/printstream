process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cspReportRouter } from './csp-report.js'

let server: Server | null = null
let warned: string[] = []

async function startServer(): Promise<string> {
  const app = express()
  app.use('/api/csp-report', cspReportRouter)
  server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, '127.0.0.1', () => resolve(nextServer))
  })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/api/csp-report`
}

async function postReport(url: string, body: string): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/csp-report' },
    body
  })
  return response.status
}

beforeEach(() => {
  warned = []
  mock.method(console, 'warn', (...args: unknown[]) => {
    warned.push(args.map(String).join(' '))
  })
})

afterEach(async () => {
  mock.restoreAll()
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve()
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

test('logs a browser-format csp-report and returns 204', async () => {
  const url = await startServer()
  const status = await postReport(url, JSON.stringify({
    'csp-report': {
      'document-uri': 'https://example.com/page',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'https://evil.example.com/x.js',
      disposition: 'enforce'
    }
  }))
  assert.equal(status, 204)
  const line = warned[0] ?? ''
  assert.equal(warned.length, 1)
  assert.ok(line.includes('script-src-elem'))
  assert.ok(line.includes('https://evil.example.com/x.js'))
})

test('dedupes repeats of the same directive+blocked-uri', async () => {
  const url = await startServer()
  const body = JSON.stringify({
    'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'https://dup.example.com/pixel.png' }
  })
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await postReport(url, body), 204)
  }
  assert.equal(warned.length, 1)
})

test('wrong-shape or empty bodies get a silent 204 (nothing to iterate against)', async () => {
  const url = await startServer()
  for (const body of [JSON.stringify({ unrelated: true }), '[]', '']) {
    assert.equal(await postReport(url, body), 204)
  }
  assert.equal(warned.length, 0)
})
