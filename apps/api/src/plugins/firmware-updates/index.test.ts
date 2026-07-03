process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, afterEach, mock, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import {
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  type Printer
} from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { printerManager } from '../../lib/printer-manager.js'
import { prisma } from '../../lib/prisma.js'
import { firmwareUpdatesPlugin, setFirmwareVersionRefreshTimeoutMsForTests } from './index.js'

// The per-printer routes authorize through the tenant-scoped singleton prisma (the
// fake context.prisma below only covers what the plugin itself queries). Stub it to
// report the test printer as owned so the gate passes; restore after each test.
const originalScopedPrinterFindUnique = prisma.printer.findUnique

const testRoot = mkdtempSync(path.join(tmpdir(), 'bambu-firmware-plugin-test-'))
process.env.LIBRARY_DIR = path.join(testRoot, 'library')
process.env.PLUGINS_DIR = path.join(testRoot, 'plugins')

const printer: Printer = {
  id: 'printer-1',
  name: 'Printer 1',
  host: '127.0.0.1',
  serial: 'SERIAL-1',
  accessCode: 'secret',
  model: 'P1S',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
}

afterEach(() => {
  mock.restoreAll()
  prisma.printer.findUnique = originalScopedPrinterFindUnique
  setFirmwareVersionRefreshTimeoutMsForTests(null)
})

after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

test('firmware-updates routes expose installable versions in the update report', async () => {
  const realFetch = globalThis.fetch
  mock.method(printerManager, 'getPrinter', () => printer)
  mock.method(printerManager, 'getStatus', () => ({ firmwareVersion: '01.09.00.00', sdCardPresent: true } as never))
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
    if (url.includes('/support/firmware-download/p1')) {
      const nextData = JSON.stringify({
        props: {
          pageProps: {
            printerMap: {
              p1: {
                versions: [{
                  version: '01.10.00.00',
                  url: 'https://public-cdn.bblmw.com/example.zip',
                  release_notes_en: '# Version 01.10.00.00',
                  release_time: '2026-04-13T03:07:41Z'
                }]
              }
            }
          }
        }
      })
      return new Response(
        `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }
    if (url.includes('wiki.bambulab.com')) {
      return new Response('<div id="h-01100000-20260330"></div>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const broadcasts: unknown[] = []
  const response = await withRegisteredPluginApp({
    prismaPrinterFindMany: async () => [{ id: printer.id }],
    wsBroadcast: (event) => {
      broadcasts.push(event)
    }
  }, async ({ baseUrl }) => {
    return fetch(`${baseUrl}/api/plugins/firmware-updates/updates`)
  })

  assert.equal(response.status, 200)
  const body = await response.json() as {
    updatesAvailable: number
    updates: Array<{
      latestVersion: string | null
      downloadUrl: string | null
      availableVersions: Array<{ version: string; fileAvailable: boolean }>
    }>
  }
  assert.equal(body.updatesAvailable, 1)
  assert.equal(body.updates[0]?.latestVersion, '01.10.00.00')
  assert.equal(body.updates[0]?.downloadUrl, 'https://public-cdn.bblmw.com/example.zip')
  assert.equal(body.updates[0]?.availableVersions[0]?.fileAvailable, true)
  assert.deepEqual(broadcasts, [])
})

test('firmware-updates upload status becomes error when a requested version has no downloadable file yet', async () => {
  const realFetch = globalThis.fetch
  mock.method(printerManager, 'getPrinter', () => printer)
  // Broadcasts are skipped when the printer's tenant can't be resolved, so this test
  // (which asserts a broadcast fires) must report a tenant for the printer.
  mock.method(printerManager, 'getTenantId', () => 'tenant-1')
  mock.method(printerManager, 'getStatus', () => ({ firmwareVersion: '01.09.00.00', sdCardPresent: true } as never))
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
    if (url.includes('/support/firmware-download/p1')) {
      const nextData = JSON.stringify({
        props: {
          pageProps: {
            printerMap: {
              p1: {
                versions: []
              }
            }
          }
        }
      })
      return new Response(
        `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }
    if (url.includes('wiki.bambulab.com')) {
      return new Response('<div id="h-01100000-20260330"></div>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const broadcasts: Array<{ event?: { status?: string; error?: string | null } }> = []
  await withRegisteredPluginApp({
    prismaPrinterFindMany: async () => [{ id: printer.id }],
    wsBroadcast: (event) => {
      broadcasts.push(event as { event?: { status?: string; error?: string | null } })
    }
  }, async ({ baseUrl }) => {
    const startResponse = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates/${printer.id}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '01.10.00.00' })
    })

    assert.equal(startResponse.status, 202)

    let statusBody: { status: string; error: string | null } | null = null
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const response = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates/${printer.id}/upload/status`)
      statusBody = await response.json() as { status: string; error: string | null }
      if (statusBody.status === 'error') break
    }

    assert.ok(statusBody)
    assert.equal(statusBody.status, 'error')
    assert.match(statusBody.error ?? '', /no download is available yet/)
  })

  assert.equal(broadcasts.some((event) => event.event?.status === 'error'), true)
})

test('firmware-updates refreshes missing firmwareVersion before computing update availability', async () => {
  const realFetch = globalThis.fetch
  const printerEvents = new PrinterEventBus()
  let currentStatus = { online: true, firmwareVersion: null, sdCardPresent: true } as never

  mock.method(printerManager, 'getPrinter', () => printer)
  mock.method(printerManager, 'getStatus', () => currentStatus)
  mock.method(printerManager, 'publishCommand', () => {
    queueMicrotask(() => {
      currentStatus = { online: true, firmwareVersion: '01.10.00.00', sdCardPresent: true } as never
      printerEvents.emit('status', {
        printerId: printer.id,
        online: true,
        firmwareVersion: '01.10.00.00',
        sdCardPresent: true
      } as never)
    })
    return true
  })
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
    if (url.includes('/support/firmware-download/p1')) {
      const nextData = JSON.stringify({
        props: {
          pageProps: {
            printerMap: {
              p1: {
                versions: [{
                  version: '01.10.00.00',
                  url: 'https://public-cdn.bblmw.com/example.zip',
                  release_notes_en: '# Version 01.10.00.00',
                  release_time: '2026-04-13T03:07:41Z'
                }]
              }
            }
          }
        }
      })
      return new Response(
        `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }
    if (url.includes('wiki.bambulab.com')) {
      return new Response('<div id="h-01100000-20260330"></div>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const response = await withRegisteredPluginApp({
    prismaPrinterFindMany: async () => [{ id: printer.id }],
    printerEvents
  }, async ({ baseUrl }) => {
    return fetch(`${baseUrl}/api/plugins/firmware-updates/updates`)
  })

  assert.equal(response.status, 200)
  const body = await response.json() as {
    updates: Array<{ currentVersion: string | null; updateAvailable: boolean }>
  }
  assert.equal(body.updates[0]?.currentVersion, '01.10.00.00')
  assert.equal(body.updates[0]?.updateAvailable, false)
})

test('firmware-updates falls back when firmwareVersion refresh times out', async () => {
  const realFetch = globalThis.fetch
  const warnings: string[] = []
  setFirmwareVersionRefreshTimeoutMsForTests(10)
  mock.method(printerManager, 'getPrinter', () => printer)
  mock.method(printerManager, 'getStatus', () => ({ online: true, firmwareVersion: null, sdCardPresent: true } as never))
  mock.method(printerManager, 'publishCommand', () => true)
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
    if (url.includes('/support/firmware-download/p1')) {
      const nextData = JSON.stringify({
        props: {
          pageProps: {
            printerMap: {
              p1: {
                versions: [{
                  version: '01.10.00.00',
                  url: 'https://public-cdn.bblmw.com/example.zip',
                  release_notes_en: '# Version 01.10.00.00',
                  release_time: '2026-04-13T03:07:41Z'
                }]
              }
            }
          }
        }
      })
      return new Response(
        `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }
    if (url.includes('wiki.bambulab.com')) {
      return new Response('<div id="h-01100000-20260330"></div>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const response = await withRegisteredPluginApp({
    prismaPrinterFindMany: async () => [{ id: printer.id }],
    loggerWarn: (message) => {
      warnings.push(message)
    }
  }, async ({ baseUrl }) => {
    return fetch(`${baseUrl}/api/plugins/firmware-updates/updates`)
  })

  assert.equal(response.status, 200)
  const body = await response.json() as {
    updates: Array<{ currentVersion: string | null; updateAvailable: boolean }>
  }
  assert.equal(body.updates[0]?.currentVersion, null)
  assert.equal(body.updates[0]?.updateAvailable, false)
  assert.equal(
    warnings.some((message) => message.includes(`firmware version refresh timed out for printer ${printer.id}`)),
    true
  )
})

test('firmware-updates report surfaces the offline floor and stepping-stone prerequisites', async () => {
  const realFetch = globalThis.fetch
  mock.method(printerManager, 'getPrinter', () => printer)
  // P1S above the offline floor (01.07.00.00) but below the Bridge Firmware (01.09.01.00).
  mock.method(printerManager, 'getStatus', () => ({ online: true, firmwareVersion: '01.09.00.00', sdCardPresent: true } as never))
  mock.method(globalThis, 'fetch', firmwareFetchMock(realFetch, [{ version: '01.10.00.00', url: 'https://public-cdn.bblmw.com/example.zip' }]))

  const response = await withRegisteredPluginApp({
    prismaPrinterFindMany: async () => [{ id: printer.id }]
  }, async ({ baseUrl }) => fetch(`${baseUrl}/api/plugins/firmware-updates/updates`))

  assert.equal(response.status, 200)
  const body = await response.json() as {
    updates: Array<{
      offlineUpdate: { minimumVersion: string | null; belowMinimum: boolean }
      availableVersions: Array<{ version: string; prerequisite: { requiredVersion: string; label: string } | null }>
    }>
  }
  assert.deepEqual(body.updates[0]?.offlineUpdate, { minimumVersion: '01.07.00.00', belowMinimum: false })
  const target = body.updates[0]?.availableVersions.find((v) => v.version === '01.10.00.00')
  assert.deepEqual(target?.prerequisite, { requiredVersion: '01.09.01.00', label: 'Bridge Firmware' })
})

test('firmware-updates upload is rejected when installed firmware is below the offline floor', async () => {
  const realFetch = globalThis.fetch
  mock.method(printerManager, 'getPrinter', () => printer)
  // P1S below the 01.07.00.00 offline floor — the printer has no Update Offline option.
  mock.method(printerManager, 'getStatus', () => ({ online: true, firmwareVersion: '01.06.00.00', sdCardPresent: true } as never))
  mock.method(globalThis, 'fetch', firmwareFetchMock(realFetch, [{ version: '01.10.00.00', url: 'https://public-cdn.bblmw.com/example.zip' }]))

  const response = await withRegisteredPluginApp({
    prismaPrinterFindMany: async () => [{ id: printer.id }]
  }, async ({ baseUrl }) => fetch(`${baseUrl}/api/plugins/firmware-updates/updates/${printer.id}/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  }))

  assert.equal(response.status, 400)
  const body = await response.json() as { error: string }
  assert.match(body.error, /at least 01\.07\.00\.00/)
  assert.match(body.error, /Update Offline/)
})

test('firmware-updates upload errors with guidance when a stepping-stone version is required', async () => {
  const realFetch = globalThis.fetch
  mock.method(printerManager, 'getPrinter', () => printer)
  mock.method(printerManager, 'getTenantId', () => 'tenant-1')
  // Above the floor, below the bridge: jumping straight to 01.10.00.00 needs 01.09.01.00 first.
  mock.method(printerManager, 'getStatus', () => ({ online: true, firmwareVersion: '01.09.00.00', sdCardPresent: true } as never))
  mock.method(globalThis, 'fetch', firmwareFetchMock(realFetch, [{ version: '01.10.00.00', url: 'https://public-cdn.bblmw.com/example.zip' }]))

  await withRegisteredPluginApp({
    prismaPrinterFindMany: async () => [{ id: printer.id }]
  }, async ({ baseUrl }) => {
    const startResponse = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates/${printer.id}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '01.10.00.00' })
    })
    assert.equal(startResponse.status, 202)

    let statusBody: { status: string; error: string | null } | null = null
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const response = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates/${printer.id}/upload/status`)
      statusBody = await response.json() as { status: string; error: string | null }
      if (statusBody.status === 'error') break
    }

    assert.ok(statusBody)
    assert.equal(statusBody.status, 'error')
    assert.match(statusBody.error ?? '', /can't be installed directly/)
    assert.match(statusBody.error ?? '', /01\.09\.01\.00 \(Bridge Firmware\)/)
  })
})

/**
 * Build a `fetch` stub covering the two Bambu upstreams the firmware source reads:
 * the bambulab.com download page (per-version URLs) and the wiki release-history
 * page (the "latest" pointer). Local FTPS calls fall through to the real fetch.
 */
function firmwareFetchMock(
  realFetch: typeof globalThis.fetch,
  downloadVersions: Array<{ version: string; url: string }>
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
    if (url.includes('/support/firmware-download/p1')) {
      const nextData = JSON.stringify({
        props: {
          pageProps: {
            printerMap: {
              p1: {
                versions: downloadVersions.map((v) => ({
                  version: v.version,
                  url: v.url,
                  release_notes_en: `# Version ${v.version}`,
                  release_time: '2026-04-13T03:07:41Z'
                }))
              }
            }
          }
        }
      })
      return new Response(
        `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }
    if (url.includes('wiki.bambulab.com')) {
      const anchors = downloadVersions
        .map((v) => `<div id="h-${v.version.replace(/\./g, '')}-20260101"></div>`)
        .join('')
      return new Response(anchors, { status: 200, headers: { 'content-type': 'text/html' } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
}

async function withRegisteredPluginApp<T>(
  options: {
    prismaPrinterFindMany: () => Promise<Array<{ id: string }>>
    printerEvents?: PrinterEventBus
    wsBroadcast?: (event: unknown) => void
    loggerWarn?: (message: string) => void
  },
  run: (context: { baseUrl: string }) => Promise<T>
): Promise<T> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [PRINTERS_VIEW_PERMISSION, PRINTERS_MANAGE_PERMISSION],
      runtimePolicy: { demoMode: false }
    } satisfies RequestAuthContext
    next()
  })

  prisma.printer.findUnique = ((async () => ({ id: printer.id })) as unknown) as typeof prisma.printer.findUnique

  const router = express.Router()
  app.use('/api/plugins/firmware-updates', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const printerEvents = options.printerEvents ?? new PrinterEventBus()

  await firmwareUpdatesPlugin.register({
    pluginName: 'firmware-updates',
    logger: {
      info() {},
      warn(message: string) {
        options.loggerWarn?.(message)
      },
      error() {}
    },
    prisma: {
      printer: {
        findMany: options.prismaPrinterFindMany
      }
    },
    printerEvents,
    ws: {
      broadcast(event: unknown) {
        options.wsBroadcast?.(event)
      }
    },
    router,
    settings: {
      async get() { return null },
      async set() {},
      async delete() {}
    },
    onShutdown() {},
    registerPrintGuard() {
      return () => {}
    }
  } as never)

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })

  try {
    const address = server.address() as AddressInfo
    return await run({ baseUrl: `http://127.0.0.1:${address.port}` })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}