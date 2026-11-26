/** Exact-name lookups must remain tenant-scoped and independent of listing caps. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { LIBRARY_VIEW_PERMISSION } from '@printstream/shared'
import { registerLibraryBrowseRoutes } from './library-browse.js'
import { prisma } from '../lib/prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { withEphemeralServer } from '../test-utils/http-test-server.js'

const stub = usePrismaStubs()

test('exact save conflict lookup scopes workspace, bridge, folder and visibility before checking a name', async () => {
  stub(prisma.libraryFile, 'findFirst', async (query: { where: Record<string, unknown> }) => {
    assert.equal(query.where.workspaceId, 'workspace')
    assert.equal(query.where.ownerBridgeId, 'bridge')
    assert.equal(query.where.folderId, 'folder')
    assert.equal(query.where.name, 'Chosen.gcode.3mf')
    assert.equal(query.where.hidden, false)
    assert.equal(query.where.deletedAt, null)
    return { id: 'omitted-from-first-thousand', name: 'Chosen.gcode.3mf' }
  })
  const app = express()
  app.use((request, _response, next) => {
    request.auth = { authEnabled: true, actor: { type: 'user', userId: 'user' }, permissions: [LIBRARY_VIEW_PERMISSION], runtimePolicy: { demoMode: false } }
    request.workspace = { id: 'workspace', slug: 'workspace', name: 'Workspace' }
    next()
  })
  const router = express.Router()
  registerLibraryBrowseRoutes(router, async () => { throw new Error('No full listing is needed') })
  app.use('/api/library', router)
  await withEphemeralServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/save-conflict?bridgeId=bridge&folderId=folder&fileName=Chosen.gcode.3mf`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { file: { id: 'omitted-from-first-thousand', name: 'Chosen.gcode.3mf' } })
  })
})
