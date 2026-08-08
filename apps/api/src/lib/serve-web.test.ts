/**
 * The SPA history fallback, tested from a data directory that looks like a real
 * Linux install.
 *
 * The bug this pins shipped: `res.sendFile(absolutePath)` is rejected by
 * `send`'s `dotfiles: 'ignore'` default whenever ANY segment of the path starts
 * with a dot -- and the Linux data directory is `~/.local/share/printstream`.
 * So on every Linux self-hosted install `/api` worked, `express.static` served
 * `/index.html`, and every SPA route (including `/`) returned 500. The app was
 * unusable in a browser while looking healthy to a health check.
 *
 * `express.static` never saw it because it only tests the path RELATIVE to its
 * own root, which is why the two disagreed about the same file.
 *
 * The dot-directory case is the whole point: a test rooted at a plain temp path
 * passes against the broken code.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import type { Server } from 'node:http'
import { installWebApp } from './serve-web.js'

async function withWebApp(webDir: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express()
  installWebApp(app, webDir)
  const server: Server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('the SPA fallback serves index.html from a data dir under a dot-directory', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'serve-web-'))
  // Mirrors the real XDG layout: ~/.local/share/printstream/web
  const webDir = path.join(base, '.local', 'share', 'printstream', 'web')
  await mkdir(webDir, { recursive: true })
  await writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>PrintStream</title>')

  try {
    await withWebApp(webDir, async (baseUrl) => {
      // The deep link a user actually opens, and the one that was 500ing.
      for (const requestPath of ['/', '/printers', '/workspaces/acme/library']) {
        const response = await fetch(`${baseUrl}${requestPath}`)
        assert.equal(response.status, 200, `${requestPath} must serve the SPA shell`)
        assert.match(await response.text(), /PrintStream/)
      }

      // The static half kept working throughout, which is what made the failure
      // look like a routing problem rather than a path problem.
      assert.equal((await fetch(`${baseUrl}/index.html`)).status, 200)

      // The dotfile rule must still apply to the part we mean to police.
      assert.equal((await fetch(`${baseUrl}/api/anything`)).status, 404)
    })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
