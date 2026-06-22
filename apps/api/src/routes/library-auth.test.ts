process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_MANAGE_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION
} from '@printstream/shared'
import yazl from 'yazl'
import { libraryRouter } from './library.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { prisma, rootPrisma } from '../lib/prisma.js'
import { restorePrismaMethodsAfterEach, usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { HttpError } from '../lib/http-error.js'

const p = prisma as unknown as Record<string, Record<string, unknown>>
// Auto-restore the prisma/rootPrisma methods these tests override (was a per-method save/restore block).
restorePrismaMethodsAfterEach([
  [p.libraryFile, 'findMany'],
  [p.libraryFile, 'findUnique'],
  [p.libraryFile, 'delete'],
  [p.libraryFile, 'update'],
  [p.libraryFileVersion, 'findMany'],
  [p.libraryFolder, 'findMany'],
  [p.libraryFolder, 'findFirst'],
  [p.bridge, 'findMany']
])
const tempDirs: string[] = []

afterEach(async () => {

  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await rm(dir, { recursive: true, force: true })
  }))
})

test('library list requires authentication once auth is enabled', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('library list allows actors with library view permission', async () => {
  prisma.libraryFile.findMany = ((async () => []) as unknown) as typeof prisma.libraryFile.findMany

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { files: [], truncated: false, fileLimit: null })
  })
})

test('library list resolves specific files by id when ?ids is supplied', async () => {
  let capturedWhere: { id?: { in?: string[] } } | undefined
  prisma.libraryFile.findMany = ((async (args: { where?: { id?: { in?: string[] } } }) => {
    capturedWhere = args.where
    return []
  }) as unknown) as typeof prisma.libraryFile.findMany

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library?ids=file-1,file-2,file-1`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { files: [], truncated: false, fileLimit: null })
    assert.deepEqual(capturedWhere?.id, { in: ['file-1', 'file-2'] }, 'dedupes and filters by the requested ids')
  })
})

test('library browse returns a read-only bridge root when no bridge is selected', async () => {
  let bridgeFindManyArgs: unknown
  prisma.bridge.findMany = ((async (args: unknown) => {
    bridgeFindManyArgs = args
    return []
  }) as unknown) as typeof prisma.bridge.findMany

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  } as RequestAuthContext & { tenant: { id: string; slug: string; name: string } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/browse`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      mode: 'bridge-root',
      readOnly: true,
      activeBridgeId: null,
      bridgeEntries: [],
      folders: [],
      files: [],
      truncated: false,
      fileLimit: null
    })
    assert.deepEqual(bridgeFindManyArgs, {
      where: { tenantId: 'tenant-1' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true }
    })
  })
})

test('library folders are tenant scoped when a tenant is present', async () => {
  let folderFindManyArgs: unknown
  prisma.libraryFolder.findMany = ((async (args: unknown) => {
    folderFindManyArgs = args
    return []
  }) as unknown) as typeof prisma.libraryFolder.findMany

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  } as RequestAuthContext & { tenant: { id: string; slug: string; name: string } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/folders`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { folders: [] })
    assert.deepEqual(folderFindManyArgs, {
      where: {
        ownerBridgeId: { not: null },
        tenantId: 'tenant-1'
      },
      orderBy: { name: 'asc' }
    })
  })
})

test('library browse collapses to the sole bridge subtree when only one bridge exists', async () => {
  prisma.libraryFile.findMany = ((async () => []) as unknown) as typeof prisma.libraryFile.findMany
  prisma.libraryFolder.findMany = ((async () => []) as unknown) as typeof prisma.libraryFolder.findMany
  prisma.bridge.findMany = ((async () => [
    { id: 'bridge-1', name: 'Bridge One', connected: true }
  ]) as unknown) as typeof prisma.bridge.findMany

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/browse`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      mode: 'bridge-subtree',
      readOnly: false,
      activeBridgeId: 'bridge-1',
      bridgeEntries: [
        { id: 'bridge-1', name: 'Bridge One', connected: false }
      ],
      folders: [],
      files: [],
      truncated: false,
      fileLimit: null
    })
  })
})

test('library browse returns a read-only bridge root when multiple bridges exist', async () => {
  prisma.bridge.findMany = ((async () => [
    { id: 'bridge-1', name: 'Bridge One', connected: true },
    { id: 'bridge-2', name: 'Bridge Two', connected: false }
  ]) as unknown) as typeof prisma.bridge.findMany

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/browse`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      mode: 'bridge-root',
      readOnly: true,
      activeBridgeId: null,
      bridgeEntries: [
        { id: 'bridge-1', name: 'Bridge One', connected: false },
        { id: 'bridge-2', name: 'Bridge Two', connected: false }
      ],
      folders: [],
      files: [],
      truncated: false,
      fileLimit: null
    })
  })
})

test('library browse returns a mutable bridge subtree when a bridge is selected', async () => {
  prisma.libraryFile.findMany = ((async () => []) as unknown) as typeof prisma.libraryFile.findMany
  prisma.libraryFolder.findMany = ((async () => []) as unknown) as typeof prisma.libraryFolder.findMany
  prisma.bridge.findMany = ((async () => [
    { id: 'bridge-1', name: 'Bridge One', connected: true },
    { id: 'bridge-2', name: 'Bridge Two', connected: false }
  ]) as unknown) as typeof prisma.bridge.findMany

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/browse?bridgeId=bridge-1`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      mode: 'bridge-subtree',
      readOnly: false,
      activeBridgeId: 'bridge-1',
      bridgeEntries: [
        { id: 'bridge-1', name: 'Bridge One', connected: false },
        { id: 'bridge-2', name: 'Bridge Two', connected: false }
      ],
      folders: [],
      files: [],
      truncated: false,
      fileLimit: null
    })
  })
})

test('library download returns 403 without download permission', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/download`)

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('library folder management returns 403 without manage permission', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Folder' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('library folder creation requires an explicit bridge selection', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' },
    permissions: [LIBRARY_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  } as RequestAuthContext & { tenant: { id: string; slug: string; name: string } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Folder' })
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Select a bridge before creating a folder' })
  })
})

test('library upload requires an explicit bridge selection', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  } as RequestAuthContext & { tenant: { id: string; slug: string; name: string } }, async (baseUrl) => {
    const form = new FormData()
    form.append('file', new Blob(['bridge-backed file']), 'bridge-test.3mf')

    const response = await fetch(`${baseUrl}/api/library`, {
      method: 'POST',
      body: form
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Select a bridge before uploading to the library' })
  })
})

test('chunked library upload assembles chunks before applying upload validation', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  } as RequestAuthContext & { tenant: { id: string; slug: string; name: string } }, async (baseUrl) => {
    const beginResponse = await fetch(`${baseUrl}/api/library/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'bridge-test.3mf', sizeBytes: 18 })
    })
    assert.equal(beginResponse.status, 201)
    const beginBody = await beginResponse.json() as { uploadId: string; chunkSizeBytes: number; uploadedBytes: number }
    assert.equal(typeof beginBody.uploadId, 'string')
    assert.equal(beginBody.uploadedBytes, 0)
    assert.ok(beginBody.chunkSizeBytes > 0)

    const chunkResponse = await fetch(`${baseUrl}/api/library/uploads/${beginBody.uploadId}/chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Offset': '0'
      },
      body: Buffer.from('bridge-backed file')
    })
    assert.equal(chunkResponse.status, 200)
    assert.deepEqual(await chunkResponse.json(), { uploadedBytes: 18, complete: true })

    const statusResponse = await fetch(`${baseUrl}/api/library/uploads/${beginBody.uploadId}`)
    assert.equal(statusResponse.status, 200)
    assert.deepEqual(await statusResponse.json(), {
      upload: {
        id: beginBody.uploadId,
        fileName: 'bridge-test.3mf',
        sizeBytes: 18,
        receivedBytes: 18,
        phase: 'receiving',
        bridgeReceivedBytes: 0
      }
    })

    const completeResponse = await fetch(`${baseUrl}/api/library/uploads/${beginBody.uploadId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    assert.equal(completeResponse.status, 400)
    assert.deepEqual(await completeResponse.json(), { error: 'Select a bridge before uploading to the library' })
  })
})

test('chunked library upload rejects out-of-order chunks and can be cancelled', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' },
    permissions: [LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  } as RequestAuthContext & { tenant: { id: string; slug: string; name: string } }, async (baseUrl) => {
    const beginResponse = await fetch(`${baseUrl}/api/library/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'bridge-test.3mf', sizeBytes: 18 })
    })
    assert.equal(beginResponse.status, 201)
    const beginBody = await beginResponse.json() as { uploadId: string }

    const chunkResponse = await fetch(`${baseUrl}/api/library/uploads/${beginBody.uploadId}/chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Offset': '5'
      },
      body: Buffer.from('bridge-backed file')
    })
    assert.equal(chunkResponse.status, 409)
    assert.deepEqual(await chunkResponse.json(), { error: 'Upload offset mismatch. Resume at byte 0.' })

    const cancelResponse = await fetch(`${baseUrl}/api/library/uploads/${beginBody.uploadId}`, { method: 'DELETE' })
    assert.equal(cancelResponse.status, 204)
  })
})

test('library file history lists the current file and older versions', async () => {
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: 'bridge-1',
    folderId: null,
    name: 'History Test.3mf',
    storedPath: 'history-test-current.3mf',
    sizeBytes: 2048,
    kind: 'other',
    thumbnailPath: null,
    uploadedAt: new Date('2026-05-20T12:00:00.000Z'),
    currentVersionNumber: 2,
    hidden: false,
    snapshotKey: null
  })) as unknown) as typeof prisma.libraryFile.findUnique
  prisma.libraryFileVersion.findMany = ((async () => ([
    {
      id: 'version-1',
      tenantId: 'tenant-1',
      libraryFileId: 'file-1',
      ownerBridgeId: 'bridge-1',
      folderId: null,
      name: 'History Test.3mf',
      storedPath: 'history-test-v1.3mf',
      sizeBytes: 1024,
      kind: 'other',
      thumbnailPath: null,
      uploadedAt: new Date('2026-05-19T12:00:00.000Z'),
      versionNumber: 1
    }
  ])) as unknown) as typeof prisma.libraryFileVersion.findMany

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/versions`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      currentFileId: 'file-1',
      versions: [
        {
          id: 'file-1',
          libraryFileId: 'file-1',
          versionId: null,
          versionNumber: 2,
          isCurrent: true,
          name: 'History Test.3mf',
          sizeBytes: 2048,
          uploadedAt: '2026-05-20T12:00:00.000Z',
          kind: 'other',
          thumbnailPath: null,
          folderId: null,
          compatiblePrinterModels: [],
          plateTypeChips: [],
          nozzleSizeChips: [],
          projectFilamentChips: [],
          plateCount: 0,
          createdByName: null,
          restoredFromVersionNumber: null
        },
        {
          id: 'version-1',
          libraryFileId: 'file-1',
          versionId: 'version-1',
          versionNumber: 1,
          isCurrent: false,
          name: 'History Test.3mf',
          sizeBytes: 1024,
          uploadedAt: '2026-05-19T12:00:00.000Z',
          kind: 'other',
          thumbnailPath: null,
          folderId: null,
          compatiblePrinterModels: [],
          plateTypeChips: [],
          nozzleSizeChips: [],
          projectFilamentChips: [],
          plateCount: 0,
          createdByName: null,
          restoredFromVersionNumber: null
        }
      ]
    })
  })
})

test('demo library delete rejects deleting visible curated files', async () => {
  let deleteCalled = false
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: 'bridge-1',
    folderId: null,
    name: 'Demo File.3mf',
    storedPath: 'Demo_File.3mf',
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique
  prisma.libraryFile.delete = ((async () => {
    deleteCalled = true
    return {} as never
  }) as unknown) as typeof prisma.libraryFile.delete

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    tenant: { id: 'tenant-1', slug: 'demo', name: 'Public Demo' },
    permissions: [LIBRARY_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: true }
  } as RequestAuthContext & { tenant: { id: string; slug: string; name: string } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1`, { method: 'DELETE' })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'Curated demo library files are read-only in the public demo.' })
    assert.equal(deleteCalled, false)
  })
})

test('demo library patch rejects mutating visible curated files', async () => {
  let updateCalled = false
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: 'bridge-1',
    folderId: null,
    name: 'Demo File.3mf',
    storedPath: 'Demo_File.3mf',
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique
  prisma.libraryFile.update = ((async () => {
    updateCalled = true
    return {} as never
  }) as unknown) as typeof prisma.libraryFile.update

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    tenant: { id: 'tenant-1', slug: 'demo', name: 'Public Demo' },
    permissions: [LIBRARY_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: true }
  } as RequestAuthContext & { tenant: { id: string; slug: string; name: string } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Demo File.3mf' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'Curated demo library files are read-only in the public demo.' })
    assert.equal(updateCalled, false)
  })
})

test('library print dispatch returns 403 without print dispatch permission', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: 'printer-1', plate: 1, useAms: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('library print dispatch passes authorization with prints.dispatch permission', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION, PRINTS_DISPATCH_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: 'printer-1', plate: 1, useAms: true })
    })

    assert.notEqual(response.status, 401)
    assert.notEqual(response.status, 403)
  })
})

test('library plates responses require private revalidation', async () => {
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Plain File.stl',
    storedPath: 'Plain_File.stl',
    sizeBytes: 1024,
    kind: 'stl',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/plates`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-cache, max-age=0, must-revalidate, s-maxage=0')
    assert.ok(response.headers.get('etag'))
    assert.deepEqual(await response.json(), {
      plates: [],
      projectFilaments: [],
      compatiblePrinterModels: [],
      supportFilamentIds: [],
      printerProfileName: null,
      processProfileName: null
    })
  })
})

test('library plates responses return 304 when the file validator still matches', async () => {
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Plain File.stl',
    storedPath: 'Plain_File.stl',
    sizeBytes: 1024,
    kind: 'stl',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const firstResponse = await fetch(`${baseUrl}/api/library/file-1/plates`)
    const etag = firstResponse.headers.get('etag')
    assert.equal(firstResponse.status, 200)
    assert.ok(etag)

    const secondResponse = await fetch(`${baseUrl}/api/library/file-1/plates`, {
      headers: { 'If-None-Match': etag }
    })

    assert.equal(secondResponse.status, 304)
    assert.equal(secondResponse.headers.get('cache-control'), 'private, no-cache, max-age=0, must-revalidate, s-maxage=0')
    assert.equal(await secondResponse.text(), '')
  })
})

test('library plate gcode returns the selected plate payload', async () => {
  const archivePath = await createSceneArchive({
    rootModelXml: MINIMAL_SCENE_MODEL_XML,
    modelSettingsXml: MINIMAL_SCENE_MODEL_SETTINGS_XML,
    projectSettingsJson: '{}',
    entries: [{ name: 'Metadata/plate_1.gcode', content: '; HEADER_BLOCK_START\n; model printing time: 1h\nG1 X10 Y10\n' }]
  })
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Cylinders.gcode.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: 'gcode',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/plate-gcode?plate=1`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'private, no-cache, max-age=0, must-revalidate, s-maxage=0')
    assert.match(await response.text(), /^; HEADER_BLOCK_START/)
  })
})

test('library plate gcode is unavailable for non-3mf library files', async () => {
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Plain File.stl',
    storedPath: 'Plain_File.stl',
    sizeBytes: 1024,
    kind: 'stl',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/plate-gcode?plate=1`)

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'No plate preview available' })
  })
})

test('library preview asset returns the embedded STL source for non-gcode 3mf files', async () => {
  const archivePath = await createEmbeddedPreviewArchive('Sources/model.stl', SIMPLE_STL)
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Model Project.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const assetResponse = await fetch(`${baseUrl}/api/library/file-1/preview-asset`)

    assert.equal(assetResponse.status, 200)
    assert.deepEqual(await assetResponse.json(), {
      kind: 'stl',
      entryPath: 'Sources/model.stl'
    })

    const contentResponse = await fetch(`${baseUrl}/api/library/file-1/preview-asset/content?entry=${encodeURIComponent('Sources/model.stl')}`)

    assert.equal(contentResponse.status, 200)
    assert.equal(contentResponse.headers.get('content-type'), 'model/stl')
    assert.equal(contentResponse.headers.get('cache-control'), 'private, no-cache, max-age=0, must-revalidate, s-maxage=0')
    assert.match(await contentResponse.text(), /^solid embedded-preview/)
  })
})

test('library preview asset reports when a 3mf has no embedded STL or STEP sources', async () => {
  // A scene 3MF that embeds no Sources/*.stl|step|stp entry.
  const archivePath = await createSceneArchive({
    rootModelXml: MINIMAL_SCENE_MODEL_XML,
    modelSettingsXml: MINIMAL_SCENE_MODEL_SETTINGS_XML,
    projectSettingsJson: '{}'
  })
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Preview-less project.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/preview-asset`)

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'No embedded STL or STEP preview source found' })
  })
})

test('library scene returns plated mesh metadata with bed bounds and filament colors', async () => {
  const archivePath = await createSceneArchive({
    rootModelXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
      '  <resources>',
      '    <object id="10" type="model">',
      '      <components>',
      '        <component objectid="1" p:path="/3D/Objects/object_203.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      '      </components>',
      '    </object>',
      '  </resources>',
      '  <build>',
      '    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 175 160 0" printable="1"/>',
      '  </build>',
      '</model>'
    ].join('\n'),
    modelSettingsXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '  <object id="10">',
      '    <metadata key="name" value="Golf tee"/>',
      '    <part id="1">',
      '      <metadata key="name" value="Golf tee"/>',
      '      <metadata key="extruder" value="1"/>',
      '    </part>',
      '  </object>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <model_instance>',
      '      <metadata key="object_id" value="10"/>',
      '      <metadata key="instance_id" value="0"/>',
      '    </model_instance>',
      '  </plate>',
      '</config>'
    ].join('\n'),
    projectSettingsJson: JSON.stringify({
      curr_bed_type: 'High Temp Plate',
      extruder_printable_area: ['0x0,350x0,350x320,0x320'],
      filament_colour: ['#FFC72C'],
      filament_type: ['ABS'],
      filament_settings_id: ['Bambu ABS'],
      printer_model: 'Bambu Lab H2D'
    })
  })
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Golf tee.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/scene?plate=1`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-cache, max-age=0, must-revalidate, s-maxage=0')
    const body = await response.json()
    assert.equal(body.plateIndex, 1)
    assert.equal(body.bed.minX, 0)
    assert.equal(body.bed.maxX, 350)
    assert.equal(body.bed.minY, 0)
    assert.equal(body.bed.maxY, 320)
    assert.equal(body.bed.plateType, 'High Temp Plate')
    assert.ok(Array.isArray(body.bed.excludeAreas))
    assert.ok(Array.isArray(body.parts))
    assert.ok(body.parts.length > 0)
    assert.equal(body.parts[0]?.entryPath, '3D/Objects/object_203.model')
    assert.equal(typeof body.parts[0]?.objectId, 'number')
    assert.ok(Array.isArray(body.parts[0]?.transform))
    assert.equal(body.parts[0]?.transform.length, 12)
    assert.equal(body.parts[0]?.filamentName, 'Bambu ABS')
    assert.equal(body.parts[0]?.color, '#FFC72C')
  })
})

test('library scene folds root build transforms into multi-part plate placements', async () => {
  // One object with five component parts; the root build-item translation must be folded into
  // every component placement so all parts land at the translated location (and inside the bed).
  const components = [
    { id: 1, tx: 0, ty: 0 },
    { id: 2, tx: 10, ty: 0 },
    { id: 3, tx: 0, ty: 10 },
    { id: 4, tx: 10, ty: 10 },
    { id: 5, tx: 5, ty: 5 }
  ]
  const archivePath = await createSceneArchive({
    rootModelXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
      '  <resources>',
      '    <object id="10" type="model">',
      '      <components>',
      ...components.map((c) => `        <component objectid="${c.id}" p:path="/3D/Objects/object_${c.id}.model" transform="1 0 0 0 1 0 0 0 1 ${c.tx} ${c.ty} 0"/>`),
      '      </components>',
      '    </object>',
      '  </resources>',
      '  <build>',
      '    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 120 120 0" printable="1"/>',
      '  </build>',
      '</model>'
    ].join('\n'),
    modelSettingsXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '  <object id="10">',
      '    <metadata key="name" value="Five-part widget"/>',
      ...components.map((c) => [
        `    <part id="${c.id}">`,
        `      <metadata key="name" value="Part ${c.id}"/>`,
        '      <metadata key="extruder" value="1"/>',
        '    </part>'
      ].join('\n')),
      '  </object>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <model_instance>',
      '      <metadata key="object_id" value="10"/>',
      '      <metadata key="instance_id" value="0"/>',
      '    </model_instance>',
      '  </plate>',
      '</config>'
    ].join('\n'),
    projectSettingsJson: JSON.stringify({
      curr_bed_type: 'Textured PEI Plate',
      extruder_printable_area: ['0x0,256x0,256x256,0x256'],
      filament_colour: ['#FFC72C'],
      filament_type: ['PLA'],
      filament_settings_id: ['Bambu PLA Basic']
    })
  })
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Five-part widget.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/scene?plate=1`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.plateIndex, 1)
    assert.ok(Array.isArray(body.parts))
    assert.ok(body.parts.length >= 5)
    const translatedPart = body.parts.find((part: { transform?: number[] }) => {
      const transform = part.transform ?? []
      return Math.abs(transform[9] ?? 0) > 1 || Math.abs(transform[10] ?? 0) > 1 || Math.abs(transform[11] ?? 0) > 1
    })
    assert.ok(translatedPart)
    const outsideBed = body.parts.filter((part: { transform?: number[] }) => {
      const transform = part.transform ?? []
      const x = transform[9] ?? 0
      const y = transform[10] ?? 0
      return x < body.bed.minX || x > body.bed.maxX || y < body.bed.minY || y > body.bed.maxY
    })
    assert.equal(outsideBed.length, 0)
  })
})

test('library scene normalizes later plates into plate-local coordinates', async () => {
  // BambuStudio lays plates out on a grid offset by bed*(1+1/5). With a 256mm bed the stride is
  // 307.2mm, so plate 2's object sits at global x=435.2 and plate 3's at global y=-179.2; the
  // reader must subtract each plate's grid origin to return plate-local (in-bed) coordinates.
  const archivePath = await createSceneArchive({
    rootModelXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
      '  <resources>',
      '    <object id="10" type="model"><components><component objectid="1" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>',
      '    <object id="20" type="model"><components><component objectid="2" p:path="/3D/Objects/object_2.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>',
      '    <object id="30" type="model"><components><component objectid="3" p:path="/3D/Objects/object_3.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>',
      '  </resources>',
      '  <build>',
      '    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 128 128 0" printable="1"/>',
      '    <item objectid="20" transform="1 0 0 0 1 0 0 0 1 435.2 128 0" printable="1"/>',
      '    <item objectid="30" transform="1 0 0 0 1 0 0 0 1 128 -179.2 0" printable="1"/>',
      '  </build>',
      '</model>'
    ].join('\n'),
    modelSettingsXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '  <object id="10"><part id="1"><metadata key="name" value="P1"/></part></object>',
      '  <object id="20"><part id="2"><metadata key="name" value="P2"/></part></object>',
      '  <object id="30"><part id="3"><metadata key="name" value="P3"/></part></object>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <model_instance><metadata key="object_id" value="10"/><metadata key="instance_id" value="0"/></model_instance>',
      '  </plate>',
      '  <plate>',
      '    <metadata key="plater_id" value="2"/>',
      '    <model_instance><metadata key="object_id" value="20"/><metadata key="instance_id" value="0"/></model_instance>',
      '  </plate>',
      '  <plate>',
      '    <metadata key="plater_id" value="3"/>',
      '    <model_instance><metadata key="object_id" value="30"/><metadata key="instance_id" value="0"/></model_instance>',
      '  </plate>',
      '</config>'
    ].join('\n'),
    projectSettingsJson: JSON.stringify({
      curr_bed_type: 'Textured PEI Plate',
      extruder_printable_area: ['0x0,256x0,256x256,0x256']
    })
  })
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Multi-plate project.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const plateExpectations = [
      { plate: 2, entryPath: '3D/Objects/object_2.model' },
      { plate: 3, entryPath: '3D/Objects/object_3.model' }
    ]

    for (const expectation of plateExpectations) {
      const response = await fetch(`${baseUrl}/api/library/file-1/scene?plate=${expectation.plate}`)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.ok(Array.isArray(body.parts))
      assert.ok(body.parts.length > 0)
      assert.ok(body.parts.every((part: { entryPath?: string }) => part.entryPath === expectation.entryPath))
      const outsideBed = body.parts.filter((part: { transform?: number[] }) => {
        const transform = part.transform ?? []
        const x = transform[9] ?? 0
        const y = transform[10] ?? 0
        return x < body.bed.minX || x > body.bed.maxX || y < body.bed.minY || y > body.bed.maxY
      })
      assert.equal(outsideBed.length, 0)
    }
  })
})

test('library scene preserves raw printable-area coordinates for H2D storage box scenes', async () => {
  // H2D dual-nozzle printable areas: the bed extent is the union of both extruders' reachable
  // rectangles (0..350 x 0..320), kept as raw coordinates rather than recentered.
  const archivePath = await createSceneArchive({
    rootModelXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
      '  <resources>',
      '    <object id="10" type="model">',
      '      <components>',
      '        <component objectid="1" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      '      </components>',
      '    </object>',
      '  </resources>',
      '  <build>',
      '    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 175 160 0" printable="1"/>',
      '  </build>',
      '</model>'
    ].join('\n'),
    modelSettingsXml: MINIMAL_SCENE_MODEL_SETTINGS_XML,
    projectSettingsJson: JSON.stringify({
      curr_bed_type: 'Cool Plate',
      extruder_printable_area: ['0x0,325x0,325x320,0x320', '25x0,350x0,350x320,25x320'],
      printer_model: 'Bambu Lab H2D'
    })
  })
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Storage Box.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/scene?plate=1`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.bed.minX, 0)
    assert.equal(body.bed.maxX, 350)
    assert.equal(body.bed.minY, 0)
    assert.equal(body.bed.maxY, 320)
    assert.ok(Array.isArray(body.parts))
    assert.ok(body.parts.length > 0)
    const outsideBed = body.parts.filter((part: { transform?: number[] }) => {
      const transform = part.transform ?? []
      const x = transform[9] ?? 0
      const y = transform[10] ?? 0
      return x < body.bed.minX || x > body.bed.maxX || y < body.bed.minY || y > body.bed.maxY
    })
    assert.equal(outsideBed.length, 0)
  })
})

test('library scene falls back to raw P1S bed bounds when printable area metadata is missing', async () => {
  const archivePath = await createSceneArchive({
    rootModelXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
      '  <resources>',
      '    <object id="10" type="model">',
      '      <components>',
      '        <component objectid="1" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      '      </components>',
      '    </object>',
      '  </resources>',
      '  <build>',
      '    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 220 210 0" printable="1"/>',
      '  </build>',
      '</model>'
    ].join('\n'),
    modelSettingsXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '  <object id="10">',
      '    <part id="1">',
      '      <metadata key="name" value="P1S scene part"/>',
      '    </part>',
      '  </object>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <metadata key="plater_name" value="Plate 1"/>',
      '    <model_instance>',
      '      <metadata key="object_id" value="10"/>',
      '      <metadata key="instance_id" value="0"/>',
      '    </model_instance>',
      '  </plate>',
      '</config>'
    ].join('\n'),
    projectSettingsJson: JSON.stringify({
      curr_bed_type: 'Textured PEI Plate',
      extruder_printable_area: [],
      machine_start_gcode: ';===== machine: P1S-0.4 ======================'
    })
  })

  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Tests P1S.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/scene?plate=1`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.bed.minX, 0)
    assert.equal(body.bed.maxX, 256)
    assert.equal(body.bed.minY, 0)
    assert.equal(body.bed.maxY, 256)
    assert.equal(body.bed.plateType, 'Textured PEI Plate')
    assert.ok(Array.isArray(body.bed.excludeAreas))
    assert.equal(body.parts.length, 1)
    assert.equal(body.parts[0]?.transform?.[9], 220)
    assert.equal(body.parts[0]?.transform?.[10], 210)
  })
})

test('library scene preserves distinct filament colors when plate filament maps are lossy', async () => {
  const archivePath = await createSceneArchive({
    rootModelXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
      '  <resources>',
      '    <object id="10" type="model">',
      '      <components>',
      '        <component objectid="1" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 24 24 0"/>',
      '        <component objectid="2" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 40 24 0"/>',
      '      </components>',
      '    </object>',
      '  </resources>',
      '  <build>',
      '    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>',
      '  </build>',
      '</model>'
    ].join('\n'),
    modelSettingsXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '  <object id="10">',
      '    <metadata key="name" value="Two-color tag"/>',
      '    <metadata key="extruder" value="1"/>',
      '    <part id="1">',
      '      <metadata key="name" value="White top"/>',
      '      <metadata key="extruder" value="1"/>',
      '    </part>',
      '    <part id="2">',
      '      <metadata key="name" value="Black underside"/>',
      '      <metadata key="extruder" value="2"/>',
      '    </part>',
      '  </object>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <metadata key="filament_maps" value="1 1"/>',
      '    <model_instance>',
      '      <metadata key="object_id" value="10"/>',
      '      <metadata key="instance_id" value="0"/>',
      '    </model_instance>',
      '  </plate>',
      '</config>'
    ].join('\n'),
    projectSettingsJson: JSON.stringify({
      curr_bed_type: 'Textured PEI Plate',
      extruder_printable_area: ['0x0,256x0,256x256,0x256'],
      filament_colour: ['#FFFFFF', '#000000'],
      filament_type: ['PLA', 'PLA'],
      filament_settings_id: ['White PLA', 'Black PLA'],
      printer_model: 'Bambu Lab P1S'
    })
  })

  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Two-color tag.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/scene?plate=1`)

    assert.equal(response.status, 200)
    const body = await response.json()
    const colors = [...new Set(body.parts.map((part: { color?: string | null }) => part.color ?? null))].sort()
    assert.deepEqual(colors, ['#000000', '#FFFFFF'])
    assert.equal(body.parts.find((part: { name?: string | null }) => part.name === 'Black underside')?.color, '#000000')
  })
})

test('library scene renders support/modifier helper subtypes tagged and material-free', async () => {
  const archivePath = await createSceneArchive({
    rootModelXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
      '  <resources>',
      '    <object id="10" type="model">',
      '      <components>',
      '        <component objectid="1" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      '        <component objectid="56" p:path="/3D/Objects/object_56.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      '      </components>',
      '    </object>',
      '  </resources>',
      '  <build>',
      '    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 128 128 0" printable="1"/>',
      '  </build>',
      '</model>'
    ].join('\n'),
    modelSettingsXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '  <object id="10">',
      '    <metadata key="name" value="Putter"/>',
      '    <part id="1">',
      '      <metadata key="name" value="Putter"/>',
      '      <metadata key="extruder" value="1"/>',
      '    </part>',
      '    <part id="56" subtype="support_blocker">',
      '      <metadata key="name" value="Generic-Cube"/>',
      '    </part>',
      '  </object>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <model_instance>',
      '      <metadata key="object_id" value="10"/>',
      '      <metadata key="instance_id" value="0"/>',
      '    </model_instance>',
      '  </plate>',
      '</config>'
    ].join('\n'),
    projectSettingsJson: JSON.stringify({
      curr_bed_type: 'Textured PEI Plate',
      extruder_printable_area: ['0x0,256x0,256x256,0x256'],
      filament_colour: ['#FFC72C'],
      filament_type: ['PLA'],
      filament_settings_id: ['Bambu PLA Basic']
    })
  })
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Putter with helper.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/scene?plate=1`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(Array.isArray(body.parts))
    assert.ok(body.parts.length > 0)
    // Support blockers/enforcers and modifier volumes are rendered translucently in the
    // editor, so the scene keeps them — tagged with their subtype and carrying no
    // filament/material (a helper must never define an instance's name or colour).
    const helper = body.parts.find((part: { objectId?: number }) => part.objectId === 56)
    assert.ok(helper, 'expected support helper 56 to be rendered')
    assert.equal(helper.name, 'Generic-Cube')
    assert.equal(helper.subtype, 'support_blocker')
    assert.equal(helper.filamentId, null)
    assert.equal(helper.color, null)
  })
})

test('library scene entry streams the requested internal model xml', async () => {
  const objectModelXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    '  <resources>',
    '    <object id="1" type="model"><mesh><vertices/><triangles/></mesh></object>',
    '  </resources>',
    '</model>'
  ].join('\n')
  const archivePath = await createSceneArchive({
    rootModelXml: MINIMAL_SCENE_MODEL_XML,
    modelSettingsXml: MINIMAL_SCENE_MODEL_SETTINGS_XML,
    projectSettingsJson: '{}',
    entries: [{ name: '3D/Objects/object_1.model', content: objectModelXml }]
  })
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Internal model.3mf',
    storedPath: archivePath,
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/scene-entry?path=${encodeURIComponent('3D/Objects/object_1.model')}`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'private, no-cache, max-age=0, must-revalidate, s-maxage=0')
    assert.match(await response.text(), /^<\?xml version="1.0" encoding="UTF-8"\?>/)
  })
})

test('library mesh streams raw STL bytes to view-permitted actors', async () => {
  const stlPath = await createStlFile()
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Plain File.stl',
    storedPath: stlPath,
    sizeBytes: SIMPLE_STL.length,
    kind: 'stl',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/mesh`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'model/stl')
    assert.ok(response.headers.get('etag'))
    assert.equal(await response.text(), SIMPLE_STL)
  })
})

test('library mesh is unavailable for non-stl files', async () => {
  prisma.libraryFile.findUnique = ((async () => ({
    id: 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: null,
    folderId: null,
    name: 'Model Project.3mf',
    storedPath: 'Model_Project.3mf',
    sizeBytes: 1024,
    kind: '3mf',
    hidden: false,
    compatiblePrinterModels: null,
    snapshotKey: null,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  })) as unknown) as typeof prisma.libraryFile.findUnique

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/mesh`)

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'No mesh available' })
  })
})

// --- Short-lived download links (the "Open in Bambu Studio" desktop deep link) ---

const downloadLinkStub = usePrismaStubs()

const DOWNLOAD_LINK_FILE_ROW = {
  id: 'file-1',
  tenantId: 'tenant-1',
  ownerBridgeId: null,
  folderId: null,
  name: 'Widget.3mf',
  storedPath: 'Widget.3mf',
  sizeBytes: 1024,
  kind: '3mf',
  hidden: false,
  snapshotKey: null,
  currentVersionNumber: 1,
  uploadedAt: new Date('2026-05-01T00:00:00.000Z')
}

const ANONYMOUS_AUTH: RequestAuthContext = {
  authEnabled: true,
  actor: { type: 'anonymous' },
  permissions: [],
  runtimePolicy: { demoMode: false }
}

test('download link mint requires download permission', async () => {
  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/download-link`, { method: 'POST' })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('download link mint returns a self-contained URL whose token is persisted only as a hash', async () => {
  let createdData: { tokenHash: string; expiresAt: Date; libraryFileId: string; tenantId: string } | null = null
  downloadLinkStub(prisma.libraryFile, 'findUnique', async () => DOWNLOAD_LINK_FILE_ROW)
  downloadLinkStub(prisma.libraryDownloadLink, 'deleteMany', async () => ({ count: 0 }))
  downloadLinkStub(prisma.libraryDownloadLink, 'create', async (args: { data: typeof createdData }) => {
    createdData = args.data
    return {}
  })
  // Mint resolves actor attribution via rootPrisma; keep it off the real DB.
  downloadLinkStub(rootPrisma.authUser, 'findUnique', async () => null)

  await withLibraryApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_DOWNLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const before = Date.now()
    const response = await fetch(`${baseUrl}/api/library/file-1/download-link`, { method: 'POST' })

    assert.equal(response.status, 200)
    const body = await response.json() as { url: string; expiresAt: string }
    const prefix = `${baseUrl}/api/library/download-links/`
    assert.ok(body.url.startsWith(prefix), body.url)
    assert.ok(body.url.endsWith('/Widget.3mf'), body.url)

    const token = body.url.slice(prefix.length, body.url.lastIndexOf('/'))
    assert.ok(token.length > 0)
    // The raw token must never be stored — only its SHA-256 hash.
    assert.equal(createdData?.tokenHash, createHash('sha256').update(token).digest('hex'))
    assert.notEqual(createdData?.tokenHash, token)
    assert.equal(createdData?.libraryFileId, 'file-1')

    const expiresAt = new Date(body.expiresAt).getTime()
    assert.ok(expiresAt > before && expiresAt <= before + 10 * 60 * 1000 + 5000)
  })
})

test('download link fetch streams the file for a valid, unexpired token without auth', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-download-link-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, 'Widget.3mf')
  await writeFile(filePath, 'PK-the-bytes', 'utf8')

  downloadLinkStub(rootPrisma.libraryDownloadLink, 'findUnique', async () => ({
    id: 'link-1',
    tenantId: 'tenant-1',
    libraryFileId: 'file-1',
    expiresAt: new Date(Date.now() + 60_000)
  }))
  downloadLinkStub(rootPrisma.libraryFile, 'findFirst', async () => ({
    ...DOWNLOAD_LINK_FILE_ROW,
    storedPath: filePath
  }))

  await withLibraryApp(ANONYMOUS_AUTH, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/download-links/sometoken/Widget.3mf`)

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') ?? '', /attachment/)
    assert.equal(await response.text(), 'PK-the-bytes')
  })
})

test('download link fetch returns 404 for an expired token', async () => {
  downloadLinkStub(rootPrisma.libraryDownloadLink, 'findUnique', async () => ({
    id: 'link-1',
    tenantId: 'tenant-1',
    libraryFileId: 'file-1',
    expiresAt: new Date(Date.now() - 1000)
  }))

  await withLibraryApp(ANONYMOUS_AUTH, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/download-links/expiredtoken/Widget.3mf`)

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Download link not found or expired' })
  })
})

test('download link fetch returns 404 for an unknown token', async () => {
  downloadLinkStub(rootPrisma.libraryDownloadLink, 'findUnique', async () => null)

  await withLibraryApp(ANONYMOUS_AUTH, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/download-links/bogus/Widget.3mf`)

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Download link not found or expired' })
  })
})

async function withLibraryApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = (auth as RequestAuthContext & { tenant?: { id: string; slug: string; name: string } | null }).tenant ?? null
    next()
  })
  app.use('/api/library', libraryRouter)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run(baseUrl)
  } finally {
    await close(server)
  }
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
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

async function createStlFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-library-mesh-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, 'model.stl')
  await writeFile(filePath, SIMPLE_STL, 'utf8')
  return filePath
}

async function createEmbeddedPreviewArchive(entryPath: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-library-preview-'))
  tempDirs.push(dir)
  const archivePath = path.join(dir, 'embedded-preview.3mf')
  const zipFile = new yazl.ZipFile()
  const output = createWriteStream(archivePath)

  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    zipFile.outputStream.on('error', reject)
    zipFile.outputStream.pipe(output)
    zipFile.addBuffer(Buffer.from(content, 'utf8'), entryPath)
    zipFile.end()
  })

  return archivePath
}

async function createSceneArchive({
  rootModelXml,
  modelSettingsXml,
  projectSettingsJson,
  entries = []
}: {
  rootModelXml: string
  modelSettingsXml: string
  projectSettingsJson: string
  /** Extra archive entries (plate gcode, sub-model XML, ...) beyond the three core documents. */
  entries?: Array<{ name: string; content: string | Buffer }>
}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-library-scene-'))
  tempDirs.push(dir)
  const archivePath = path.join(dir, 'scene-preview.3mf')
  const zipFile = new yazl.ZipFile()
  const output = createWriteStream(archivePath)

  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    zipFile.outputStream.on('error', reject)
    zipFile.outputStream.pipe(output)
    zipFile.addBuffer(Buffer.from(rootModelXml, 'utf8'), '3D/3dmodel.model')
    zipFile.addBuffer(Buffer.from(modelSettingsXml, 'utf8'), 'Metadata/model_settings.config')
    zipFile.addBuffer(Buffer.from(projectSettingsJson, 'utf8'), 'Metadata/project_settings.config')
    for (const entry of entries) {
      zipFile.addBuffer(Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8'), entry.name)
    }
    zipFile.end()
  })

  return archivePath
}

const SIMPLE_STL = [
  'solid embedded-preview',
  'facet normal 0 0 1',
  'outer loop',
  'vertex 0 0 0',
  'vertex 1 0 0',
  'vertex 0 1 0',
  'endloop',
  'endfacet',
  'endsolid embedded-preview'
].join('\n')

// A minimal single-object, single-plate scene used by tests that only need a structurally
// valid 3MF (no STL/STEP sources) rather than specific scene geometry.
const MINIMAL_SCENE_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
  '  <resources>',
  '    <object id="10" type="model">',
  '      <components>',
  '        <component objectid="1" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
  '      </components>',
  '    </object>',
  '  </resources>',
  '  <build>',
  '    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 128 128 0" printable="1"/>',
  '  </build>',
  '</model>'
].join('\n')

const MINIMAL_SCENE_MODEL_SETTINGS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="10">',
  '    <part id="1">',
  '      <metadata key="name" value="Minimal scene part"/>',
  '    </part>',
  '  </object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance>',
  '      <metadata key="object_id" value="10"/>',
  '      <metadata key="instance_id" value="0"/>',
  '    </model_instance>',
  '  </plate>',
  '</config>'
].join('\n')