process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { tagsRouter } from './tags.js'
import { HttpError } from '../lib/http-error.js'
import { withEphemeralServer } from '../test-utils/http-test-server.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import type { RequestWorkspaceSummary } from '../lib/workspace-context.js'
import { prisma } from '../lib/prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import type { Permission } from '@printstream/shared'

const stub = usePrismaStubs()

/** Exercise the real router guards without touching persistence. */
async function requestTags(permissions: Permission[], path: string, method: string, body?: unknown) {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.workspace = { id: 'w1', slug: 'w1', name: 'Workspace' } as RequestWorkspaceSummary
    request.auth = { authEnabled: true, actor: { type: 'user', userId: 'u1' }, permissions, runtimePolicy: { demoMode: false } } as RequestAuthContext
    next()
  })
  app.use('/tags', tagsRouter)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof HttpError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' })
  })
  let status = 0
  await withEphemeralServer(app, async (url) => {
    const result = await fetch(`${url}/tags/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    status = result.status
  })
  return status
}

test('printer viewing does not grant spool/library tag visibility', async () => {
  assert.equal(await requestTags(['printers.view'], 'spool', 'GET'), 403)
  assert.equal(await requestTags(['printers.view'], 'file', 'GET'), 403)
})

test('view rights cannot assign tags or edit shared vocabulary', async () => {
  assert.equal(await requestTags(['printers.view'], 'printer/assign', 'POST', { entityIds: ['p1'], add: ['t1'] }), 403)
  assert.equal(await requestTags(['library.view'], 'spool/assign', 'POST', { entityIds: ['s1'], add: ['t1'] }), 403)
  assert.equal(await requestTags(['library.view', 'library.manage'], 'file/t1', 'DELETE'), 403)
})

test('invalid kind and contradictory changes fail at the boundary', async () => {
  assert.equal(await requestTags(['library.manage'], 'preset/assign', 'POST', {}), 400)
  assert.equal(await requestTags(['library.manage'], 'spool/assign', 'POST', { entityIds: ['s1'], add: ['t1'], remove: ['t1'] }), 400)
})


test('deleting through another catalog cannot delete the original tag', async () => {
  stub(prisma.workspaceTag, 'deleteMany', async (args: { where: unknown }) => {
    assert.deepEqual(args.where, { id: 'printer-tag', workspaceId: 'w1', entityKind: 'file' })
    return { count: 0 }
  })
  assert.equal(await requestTags(['library.view', 'settings.manage'], 'file/printer-tag', 'DELETE'), 404)
})
