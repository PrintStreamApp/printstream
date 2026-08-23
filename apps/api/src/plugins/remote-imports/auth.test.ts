process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { LIBRARY_UPLOAD_PERMISSION } from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import type { persistLibraryFileFromLocalPath } from '../../lib/library-files.js'
import { bambuAccountResolvers, type BambuAccountCredential } from '../../lib/bambu-account-registry.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { prisma, rootPrisma } from '../../lib/prisma.js'
import { usePrismaStubs } from '../../test-utils/prisma-stubs.js'
import {
  assertRemoteImportUrlAllowed,
  createRemoteImportsPlugin,
  downloadToTempFile,
  isBlockedRemoteImportAddress
} from './index.js'

const stub = usePrismaStubs()

/** Mirrors `MAKERWORLD_ACCOUNT_IMPORT_SETTING`; module-private there by design. */
const MAKERWORLD_SETTING = 'makerWorldAccountImportEnabled'

const bambuAccount: BambuAccountCredential = {
  accessToken: 'bambu-access-token',
  region: 'global',
  accountLabel: 'owner@example.com'
}

type PersistedInput = Parameters<typeof persistLibraryFileFromLocalPath>[0]

/**
 * Stands in for `persistLibraryFileFromLocalPath`, recording what the plugin asked
 * it to persist. The real helper owns folder/bridge resolution, dedupe, versioning,
 * attribution, and the audit entry, this suite asserts the plugin DELEGATES those
 * rather than re-testing them here (they are covered by the library-files suite).
 */
function recordingPersist(): {
  calls: PersistedInput[]
  persist: typeof persistLibraryFileFromLocalPath
} {
  const calls: PersistedInput[] = []
  const persist = (async (input: PersistedInput) => {
    calls.push(input)
    return {
      file: {
        id: 'file-1',
        name: input.fileName,
        sizeBytes: input.sizeBytes,
        kind: input.fileName.toLowerCase().endsWith('.stl')
          ? 'stl'
          : input.fileName.toLowerCase().endsWith('.step') ? 'step' : 'gcode',
        hidden: false,
        folderId: input.folderId,
        thumbnailPath: null,
        uploadedAt: new Date('2026-05-09T00:00:00.000Z'),
        currentVersionNumber: 1,
        createdByName: 'Tester',
        restoredFromVersionNumber: null
      },
      unchanged: false,
      archivedVersionId: null
    }
  }) as unknown as typeof persistLibraryFileFromLocalPath
  return { calls, persist }
}

test('remote imports require upload permission', async () => {
  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/file.gcode.3mf' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

// Regression: the gate used to pass LIBRARY_UPLOAD_PERMISSION as its own bypass
// permission, which every caller past the route guard necessarily holds, so demo
// installs accepted unrestricted imports while appearing to be protected.
test('remote imports refuse to import in demo mode even for upload-capable users', async () => {
  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: true }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://downloads.example.com/widget.gcode.3mf',
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 403)
  })
})

test('remote imports reject Printables pages on the direct import endpoint', async () => {
  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.printables.com/model/12345-a-thing',
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /browser-side helper|browser helper/i)
  })
})

// The whole point of the opt-in: a workspace with a connected Bambu account still
// must not have it used for downloads until someone says so.
test('MakerWorld pages are refused while the account opt-in is off', async () => {
  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://makerworld.com/en/models/578636-slug#profileId-499360',
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /turned off/i)
  }, undefined, { [MAKERWORLD_SETTING]: 'false', bambuAccount: null })
})

test('MakerWorld pages are refused when no Bambu account is connected', async () => {
  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://makerworld.com/en/models/578636-slug#profileId-499360',
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /no bambu lab account is connected/i)
  }, undefined, { [MAKERWORLD_SETTING]: 'true', bambuAccount: null })
})

test('remote imports reject unsupported direct file types', async () => {
  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://downloads.example.com/model.zip',
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /web page|printable file|unsupported/i)
  })
})

test('remote imports block private and local server-download targets before fetching', async () => {
  await assert.rejects(
    assertRemoteImportUrlAllowed('https://models.example.com/file.gcode.3mf', async () => [
      { address: '10.0.0.12', family: 4 }
    ]),
    /private or local network/i
  )

  assert.equal(isBlockedRemoteImportAddress('127.0.0.1'), true)
  assert.equal(isBlockedRemoteImportAddress('169.254.169.254'), true)
  assert.equal(isBlockedRemoteImportAddress('192.168.1.20'), true)
  assert.equal(isBlockedRemoteImportAddress('93.184.216.34'), false)
})

// `URL.hostname` keeps the brackets on an IPv6 literal, so these used to reach a
// DNS lookup that merely errored instead of being range-checked and refused.
test('remote imports block bracketed IPv6 literals without resolving them', async () => {
  const neverResolves = async () => {
    throw new Error('the loopback literal must be refused before any DNS lookup')
  }

  await assert.rejects(
    assertRemoteImportUrlAllowed('http://[::1]/file.gcode', neverResolves),
    /private or local network/i
  )
  await assert.rejects(
    assertRemoteImportUrlAllowed('http://[fd00::1]/file.gcode', neverResolves),
    /private or local network/i
  )
  // febf is still link-local (fe80::/10); only matching the literal `fe80:` missed it.
  assert.equal(isBlockedRemoteImportAddress('febf::1'), true)
  assert.equal(isBlockedRemoteImportAddress('fdff::1'), true)
  assert.equal(isBlockedRemoteImportAddress('2606:2800:220:1:248:1893:25c8:1946'), false)
})

test('remote imports reject localhost direct file URLs without starting the download', async () => {
  await withRemoteImportsApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'http://localhost/file.gcode.3mf',
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /private or local network/i)
  })
})

test('remote imports reject oversized direct downloads before writing the body', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('x', {
    status: 200,
    headers: {
      'Content-Length': String(2 * 1024 * 1024 * 1024),
      'Content-Type': 'application/octet-stream'
    }
  })

  try {
    await assert.rejects(
      downloadToTempFile('https://93.184.216.34/model.gcode.3mf'),
      /upload limit/i
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('remote imports follow redirects only after validating the next target', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, {
    status: 302,
    headers: {
      Location: 'http://localhost/metadata.gcode'
    }
  })

  try {
    await assert.rejects(
      downloadToTempFile('https://93.184.216.34/model.gcode'),
      /private or local network/i
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('remote imports download valid public files to a temp path', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('gcode bytes', {
    status: 200,
    headers: {
      'Content-Disposition': 'attachment; filename="Downloaded File.gcode"',
      'Content-Type': 'application/octet-stream'
    }
  })

  let download: Awaited<ReturnType<typeof downloadToTempFile>> | null = null
  try {
    download = await downloadToTempFile('https://93.184.216.34/model.gcode')
    assert.equal(download.fileName, 'Downloaded_File.gcode')
    assert.equal(download.sizeBytes, 11)
  } finally {
    globalThis.fetch = originalFetch
    if (download) {
      await rm(download.cleanupPath, { recursive: true, force: true })
    }
  }
})

test('remote imports expose provider capabilities', async () => {
  await withRemoteImportsApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/capabilities`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.providers.map((provider: { id: string }) => provider.id), ['printables', 'makerworld', 'generic'])
    assert.equal(body.libraryFolderName, 'Imported models')
    assert.equal(body.directPrintFileTypes.includes('gcode'), true)
    // What the guard actually accepts, so the advertisement cannot drift from it.
    assert.deepEqual(body.importFileTypes, ['3mf', 'gcode', 'stl', 'step'])
  })
})

test('remote imports extension context lists upload-capable workspaces and includes bridge availability', async () => {
  stub(rootPrisma.authWorkspaceMembership, 'findMany', async () => [
    { workspace: { id: 'ws-upload', slug: 'upload', name: 'Upload Workspace', description: null } },
    { workspace: { id: 'ws-readonly', slug: 'readonly', name: 'Readonly Workspace', description: null } },
    { workspace: { id: 'ws-nobridge', slug: 'nobridge', name: 'No Bridge Workspace', description: null } }
  ])
  stub(rootPrisma.authUserGroupMembership, 'findMany', async () => [
    { group: { workspaceId: 'ws-upload', permissions: [LIBRARY_UPLOAD_PERMISSION] } },
    { group: { workspaceId: 'ws-readonly', permissions: ['library.view'] } },
    { group: { workspaceId: 'ws-nobridge', permissions: [LIBRARY_UPLOAD_PERMISSION] } }
  ])
  stub(rootPrisma.bridge, 'findMany', async () => [
    { workspaceId: 'ws-upload' },
    { workspaceId: 'ws-readonly' }
  ])
  stub(rootPrisma.setting, 'findMany', async () => [])

  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/extension-context`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authenticated: true,
      authEnabled: true,
      setupRequired: false,
      workspaces: [
        {
          workspace: { id: 'ws-nobridge', slug: 'nobridge', name: 'No Bridge Workspace', description: null },
          bridgeCount: 0
        },
        {
          workspace: { id: 'ws-upload', slug: 'upload', name: 'Upload Workspace', description: null },
          bridgeCount: 1
        }
      ]
    })
  })
})

test('remote imports persist direct file URLs through the shared library helper', async () => {
  const { calls, persist } = recordingPersist()
  stub(prisma.libraryFolder, 'findFirst', async () => null)
  stub(prisma.libraryFolder, 'create', async () => ({ id: 'folder-third-party', ownerBridgeId: 'bridge-1' }))

  const plugin = createRemoteImportsPlugin({
    async downloadToTempFile() {
      return {
        fileName: 'widget.gcode.3mf',
        filePath: '/tmp/widget.gcode.3mf',
        cleanupPath: '/tmp/widget.gcode.3mf',
        sizeBytes: 4096
      }
    },
    persistLibraryFile: persist
  })

  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://downloads.example.com/widget.gcode.3mf',
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 201)
    const body = await response.json()
    assert.equal(body.file.name, 'widget.gcode.3mf')
    assert.equal(body.resolution.strategy, 'server-download')
    assert.equal(body.canPrintDirectly, true)
    // A gcode row carries derived metadata, and nothing has parsed it yet: the DTO
    // must say "pending" rather than assert empty chips as a settled answer.
    assert.equal(body.file.metadataPending, true)
    assert.deepEqual(body.file.compatiblePrinterModels, [])
  }, plugin)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.fileName, 'widget.gcode.3mf')
  assert.equal(calls[0]?.bridgeId, 'bridge-1')
  assert.equal(calls[0]?.workspaceId, 'workspace-1')
  // Lifecycle + audit provenance come from the shared helper, so they must be asked for.
  assert.equal(calls[0]?.auditAction, 'import')
  assert.ok(calls[0]?.request, 'the request must be threaded through so the import is audited')
})

// STEP used to import fine while the rejection message and `/capabilities` both
// claimed it could not: `classifyLibraryFileKind` returns 'step', not 'other'.
test('remote imports accept STEP files, matching what capabilities advertises', async () => {
  const { calls, persist } = recordingPersist()
  stub(prisma.libraryFolder, 'findFirst', async () => null)
  stub(prisma.libraryFolder, 'create', async () => ({ id: 'folder-third-party', ownerBridgeId: 'bridge-1' }))

  const plugin = createRemoteImportsPlugin({
    async downloadToTempFile() {
      return {
        fileName: 'bracket.step',
        filePath: '/tmp/bracket.step',
        cleanupPath: '/tmp/bracket.step',
        sizeBytes: 512
      }
    },
    persistLibraryFile: persist
  })

  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://downloads.example.com/bracket.step',
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 201)
    const body = await response.json()
    assert.equal(body.canPrintDirectly, false)
    // STEP carries no derived 3MF metadata, so "pending" would never resolve.
    assert.equal(body.file.metadataPending, undefined)
  }, plugin)

  assert.equal(calls.length, 1)
})

// The full three-call chain: design -> instance f3mf -> signed CDN URL. Asserts the
// two facts that are easy to get wrong and fail only against the real service: the
// API calls carry `Bearer <token>`, and the signed URL is fetched WITHOUT it.
test('MakerWorld pages import through the connected account when opted in', async () => {
  const { calls, persist } = recordingPersist()
  stub(prisma.libraryFolder, 'findFirst', async () => null)
  stub(prisma.libraryFolder, 'create', async () => ({ id: 'folder-third-party', ownerBridgeId: 'bridge-1' }))

  const seen: Array<{ url: string; authorization: string | null }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const authorization = new Headers(init?.headers).get('authorization')
    seen.push({ url, authorization })
    if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init)
    if (url.endsWith('/design-service/design/578636')) {
      return new Response(JSON.stringify({ title: 'Sword', defaultInstanceId: 499360, instances: [{ id: 499360, title: '0.2mm' }] }), { status: 200 })
    }
    if (url.endsWith('/design-service/instance/499360/f3mf')) {
      return new Response(JSON.stringify({ name: 'sword.3mf', url: 'https://makerworld.bblmw.com/signed/abc.3mf?at=1&exp=2' }), { status: 200 })
    }
    if (url.startsWith('https://makerworld.bblmw.com/')) {
      return new Response('PK model bytes', { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  try {
    const plugin = createRemoteImportsPlugin({ persistLibraryFile: persist })
    await withRemoteImportsApp({
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [LIBRARY_UPLOAD_PERMISSION],
      runtimePolicy: { demoMode: false }
    }, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No `#profileId`, so the design's defaultInstanceId has to be looked up.
        body: JSON.stringify({ url: 'https://makerworld.com/en/models/578636-slug', bridgeId: 'bridge-1' })
      })

      assert.equal(response.status, 201)
      assert.equal((await response.json()).file.name, 'sword.3mf')
    }, plugin, { [MAKERWORLD_SETTING]: 'true', bambuAccount })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.fileName, 'sword.3mf')

  const design = seen.find((entry) => entry.url.includes('/design/578636'))
  const f3mf = seen.find((entry) => entry.url.includes('/instance/499360/f3mf'))
  const download = seen.find((entry) => entry.url.startsWith('https://makerworld.bblmw.com/'))
  assert.equal(design?.authorization, 'Bearer bambu-access-token')
  assert.equal(f3mf?.authorization, 'Bearer bambu-access-token')
  // Presigned: sending the bearer to the CDN would leak the account token to a host
  // that never needs it.
  assert.equal(download?.authorization, null)
})

// A URL that already names the profile must not cost a design lookup, that request
// is pure latency, and on a captcha-throttled account it is a second chance to fail.
test('MakerWorld URLs carrying a profile id skip the design lookup', async () => {
  const { persist } = recordingPersist()
  stub(prisma.libraryFolder, 'findFirst', async () => null)
  stub(prisma.libraryFolder, 'create', async () => ({ id: 'folder-third-party', ownerBridgeId: 'bridge-1' }))

  const seen: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push(url)
    if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init)
    if (url.endsWith('/design-service/instance/499360/f3mf')) {
      return new Response(JSON.stringify({ name: 'sword.3mf', url: 'https://makerworld.bblmw.com/signed/abc.3mf' }), { status: 200 })
    }
    if (url.startsWith('https://makerworld.bblmw.com/')) return new Response('bytes', { status: 200 })
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  try {
    const plugin = createRemoteImportsPlugin({ persistLibraryFile: persist })
    await withRemoteImportsApp({
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [LIBRARY_UPLOAD_PERMISSION],
      runtimePolicy: { demoMode: false }
    }, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://makerworld.com/en/models/578636-slug#profileId-499360', bridgeId: 'bridge-1' })
      })
      assert.equal(response.status, 201)
    }, plugin, { [MAKERWORLD_SETTING]: 'true', bambuAccount })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(seen.some((url) => url.includes('/design/')), false)
})

// Default ON: the account credential is the only way to download from MakerWorld, so a
// stored-nothing workspace must be ready to import rather than dead until a second
// toggle is found. Only an explicit opt-OUT disables it.
test('MakerWorld imports are enabled when the workspace has never set the option', async () => {
  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const body = await (await fetch(`${baseUrl}/api/plugins/remote-imports/capabilities`)).json()
    assert.equal(body.makerWorld.enabled, true)
    assert.equal(body.makerWorld.accountConnected, true)
  }, undefined, { bambuAccount })
})

test('capabilities reports the MakerWorld opt-in and which account it runs as', async () => {
  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const body = await (await fetch(`${baseUrl}/api/plugins/remote-imports/capabilities`)).json()
    assert.deepEqual(body.makerWorld, {
      enabled: true,
      accountConnected: true,
      accountLabel: 'owner@example.com'
    })
  }, undefined, { [MAKERWORLD_SETTING]: 'true', bambuAccount })
})

test('remote imports accept browser-assisted file uploads', async () => {
  const { calls, persist } = recordingPersist()
  // The extension names no folder, so this path lands in the default one.
  stub(prisma.libraryFolder, 'findFirst', async () => null)
  stub(prisma.libraryFolder, 'create', async () => ({ id: 'folder-third-party', ownerBridgeId: 'bridge-upload' }))
  const plugin = createRemoteImportsPlugin({ persistLibraryFile: persist })

  await withRemoteImportsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const body = new FormData()
    body.append('file', new Blob(['mesh']), 'upload.gcode')
    body.append('bridgeId', 'bridge-upload')
    body.append('sourceUrl', 'https://files.printables.com/upload.gcode')

    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-upload`, {
      method: 'POST',
      body
    })

    assert.equal(response.status, 201)
    const responseBody = await response.json()
    assert.equal(responseBody.file.name, 'upload.gcode')
    assert.equal(responseBody.resolution.normalizedUrl, 'https://files.printables.com/upload.gcode')
    assert.equal(responseBody.canPrintDirectly, true)
  }, plugin)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.bridgeId, 'bridge-upload')
  assert.equal(calls[0]?.fileName, 'upload.gcode')
})

// A chosen folder must be used as-is: creating `Imported models` alongside it would
// leave an empty folder behind on every import that named a destination.
test('an import into a chosen folder does not create the default folder', async () => {
  const { calls, persist } = recordingPersist()
  let folderCreateCount = 0
  stub(prisma.libraryFolder, 'findFirst', async () => null)
  stub(prisma.libraryFolder, 'create', async () => {
    folderCreateCount += 1
    return { id: 'should-not-happen', ownerBridgeId: 'bridge-1' }
  })

  const plugin = createRemoteImportsPlugin({
    async downloadToTempFile() {
      return {
        fileName: 'mesh.stl',
        filePath: '/tmp/mesh.stl',
        cleanupPath: '/tmp/mesh.stl',
        sizeBytes: 2048
      }
    },
    persistLibraryFile: persist
  })

  await withRemoteImportsApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://downloads.example.com/mesh.stl',
        bridgeId: 'bridge-1',
        folderId: 'folder-chosen'
      })
    })

    assert.equal(response.status, 201)
    assert.equal((await response.json()).canPrintDirectly, false)
  }, plugin)

  assert.equal(folderCreateCount, 0)
  assert.equal(calls[0]?.folderId, 'folder-chosen')
  // Imports are never hidden: the option is gone from the contract, and a hidden row
  // would be invisible in the library the user just imported into.
  assert.equal(calls[0]?.hidden, false)
})

test('remote imports do not store bytes when the third-party folder cannot be prepared', async () => {
  const { calls, persist } = recordingPersist()
  stub(prisma.libraryFolder, 'findFirst', async () => null)
  stub(prisma.libraryFolder, 'create', async () => {
    throw new Error('folder unavailable')
  })

  const plugin = createRemoteImportsPlugin({
    async downloadToTempFile() {
      return {
        fileName: 'widget.gcode.3mf',
        filePath: '/tmp/widget.gcode.3mf',
        cleanupPath: '/tmp/widget.gcode.3mf',
        sizeBytes: 4096
      }
    },
    persistLibraryFile: persist
  })

  await withRemoteImportsApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/remote-imports/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://downloads.example.com/widget.gcode.3mf',
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 500)
  }, plugin)

  assert.equal(calls.length, 0)
})

async function withRemoteImportsApp(
  auth: RequestAuthContext,
  run: (context: { baseUrl: string }) => Promise<void>,
  plugin = createRemoteImportsPlugin(),
  workspaceState: {
    [MAKERWORLD_SETTING]?: string
    /** Credential the registered resolver hands back; null means no connected account. */
    bambuAccount?: BambuAccountCredential | null
  } = {}
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    request.workspace = { id: 'workspace-1', slug: 'test', name: 'Test Workspace' }
    next()
  })

  const router = express.Router()
  app.use('/api/plugins/remote-imports', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const settingValues = new Map<string, string>(
    workspaceState[MAKERWORLD_SETTING] != null
      ? [[MAKERWORLD_SETTING, workspaceState[MAKERWORLD_SETTING]]]
      : []
  )
  // The plugin reaches the account through the core registry, never by importing
  // bambu-cloud-sync, so the test registers a resolver the same way that plugin does.
  const unregisterAccount = bambuAccountResolvers.register(async () => workspaceState.bambuAccount ?? null)

  await plugin.register({
    pluginName: 'remote-imports',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {} as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast() {} } as never,
    router,
    settings: {
      async get(key) { return settingValues.get(key) ?? null },
      async set(key, value) { settingValues.set(key, value) },
      async delete(key) { settingValues.delete(key) },
      forWorkspace() {
        return this
      }
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider() { return () => undefined },
    registerSlotFilamentResolver() { return () => undefined },
    registerBambuAccountResolver() { return () => undefined }
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run({ baseUrl })
  } finally {
    unregisterAccount()
    await close(server)
  }
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0)
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
