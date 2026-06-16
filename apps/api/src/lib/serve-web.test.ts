process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import express from 'express'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { installWebApp } from './serve-web.js'

const INDEX_HTML = '<!doctype html><title>PrintStream</title><div id="root"></div>'

const distDir = mkdtempSync(path.join(os.tmpdir(), 'ps-web-'))
mkdirSync(path.join(distDir, 'assets'))
writeFileSync(path.join(distDir, 'index.html'), INDEX_HTML)
writeFileSync(path.join(distDir, 'sw.js'), 'self.addEventListener("install", () => {})')
writeFileSync(path.join(distDir, 'manifest.webmanifest'), '{"name":"PrintStream"}')
writeFileSync(path.join(distDir, 'assets', 'app-abc123.js'), 'console.log(1)')

after(() => rmSync(distDir, { recursive: true, force: true }))

/** Spins up a throwaway server with a stub `/api` route plus the web handler. */
async function withWebApp(webDir: string | undefined, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express()
  app.get('/api/health', (_request, response) => {
    response.json({ ok: true })
  })
  installWebApp(app, webDir)

  const server = await new Promise<Server>((resolve) => {
    const created = app.listen(0, () => resolve(created))
  })
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('serves content-hashed assets as immutable', async () => {
  await withWebApp(distDir, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/assets/app-abc123.js`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  })
})

test('serves the service worker no-store with Service-Worker-Allowed', async () => {
  await withWebApp(distDir, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/sw.js`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    assert.equal(response.headers.get('service-worker-allowed'), '/')
  })
})

test('serves index.html no-store', async () => {
  await withWebApp(distDir, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/index.html`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  })
})

test('falls back to index.html for SPA deep links', async () => {
  await withWebApp(distDir, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/printers/some-id`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(await response.text(), INDEX_HTML)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  })
})

test('does not shadow API routes', async () => {
  await withWebApp(distDir, async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/api/health`)
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { ok: true })

    // Unknown API paths must 404, never fall back to the SPA shell.
    const missing = await fetch(`${baseUrl}/api/does-not-exist`)
    assert.equal(missing.status, 404)
    assert.notEqual(await missing.text(), INDEX_HTML)
  })
})

test('is a no-op when no web dir is configured', async () => {
  await withWebApp(undefined, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/printers/some-id`)
    assert.equal(response.status, 404)
  })
})
