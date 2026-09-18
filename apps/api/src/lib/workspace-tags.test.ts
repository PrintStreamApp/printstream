process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignWorkspaceTags, readTagSnapshot, saveWorkspaceTag } from './workspace-tags.js'
import { prisma } from './prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import type { Prisma } from '@prisma/client'

const stub = usePrismaStubs()

test('snapshot scopes nested assignments and returns no other entity kind', async () => {
  stub(prisma.workspaceTag, 'findMany', async (args: Prisma.WorkspaceTagFindManyArgs) => {
    assert.deepEqual(args.where, { workspaceId: 'w1', entityKind: 'printer' })
    assert.deepEqual(args.include?.printers, { where: { workspaceId: 'w1' }, select: { id: true } })
    assert.equal(args.include?.files, false)
    assert.equal(args.include?.spools, false)
    return [{ id: 't1', name: 'Workshop', nameKey: 'workshop', color: '#123456', group: 'Location', workspaceId: 'w1', printers: [{ id: 'p1' }] }]
  })
  assert.deepEqual(await readTagSnapshot('w1', 'printer'), {
    tags: [{ id: 't1', name: 'Workshop', color: '#123456', group: 'Location' }], assignments: { p1: ['t1'] }
  })
})

test('assignment rejects a foreign or missing entity before any write', async () => {
  let writes = 0
  const tx = {
    printer: { findMany: async (args: Prisma.PrinterFindManyArgs) => {
      assert.deepEqual(args.where, { workspaceId: 'w1', id: { in: ['p1', 'foreign'] } })
      return [{ id: 'p1' }]
    } },
    workspaceTag: { update: async () => { writes++ } }
  }
  stub(prisma, '$transaction', async (run: (tx: unknown) => Promise<void>) => run(tx))
  await assert.rejects(assignWorkspaceTags('w1', 'printer', { entityIds: ['p1', 'foreign'], add: ['t1'], remove: [] }), /unavailable/)
  assert.equal(writes, 0)
})

test('assignment rejects a foreign tag and preserves all existing assignments', async () => {
  let writes = 0
  const tx = {
    filamentSpool: { findMany: async () => [{ id: 's1' }] },
    workspaceTag: {
      findMany: async (args: Prisma.WorkspaceTagFindManyArgs) => {
        assert.deepEqual(args.where, { workspaceId: 'w1', entityKind: 'spool', id: { in: ['foreign'] } })
        return []
      },
      update: async () => { writes++ }
    }
  }
  stub(prisma, '$transaction', async (run: (tx: unknown) => Promise<void>) => run(tx))
  await assert.rejects(assignWorkspaceTags('w1', 'spool', { entityIds: ['s1'], add: ['foreign'], remove: [] }), /unavailable/)
  assert.equal(writes, 0)
})

test('bulk assignment connects and disconnects only chosen tags, without replacing a mixed set', async () => {
  const writes: unknown[] = []
  const tx = {
    libraryFile: { findMany: async (args: Prisma.LibraryFileFindManyArgs) => {
      assert.equal(args.where?.workspaceId, 'w1')
      assert.equal(args.where?.hidden, false)
      assert.equal(args.where?.deletedAt, null)
      return [{ id: 'f1' }, { id: 'f2' }]
    } },
    workspaceTag: {
      findMany: async () => [{ id: 'add' }, { id: 'remove' }],
      update: async (args: unknown) => { writes.push(args) }
    }
  }
  stub(prisma, '$transaction', async (run: (tx: unknown) => Promise<void>) => run(tx))
  await assignWorkspaceTags('w1', 'file', { entityIds: ['f1', 'f2', 'f1'], add: ['add'], remove: ['remove'] })
  assert.deepEqual(writes, [
    { where: { id: 'add', workspaceId: 'w1', entityKind: 'file' }, data: { files: { connect: [{ id: 'f1' }, { id: 'f2' }] } } },
    { where: { id: 'remove', workspaceId: 'w1', entityKind: 'file' }, data: { files: { disconnect: [{ id: 'f1' }, { id: 'f2' }] } } }
  ])
})

test('editing a tag from another entity catalog fails without writing', async () => {
  stub(prisma.workspaceTag, 'findFirst', async (args: Prisma.WorkspaceTagFindFirstArgs) => {
    assert.deepEqual(args.where, { id: 'printer-tag', workspaceId: 'w1', entityKind: 'spool' })
    return null
  })
  await assert.rejects(saveWorkspaceTag('w1', 'spool', { name: 'Phaetus Conch', group: 'Nozzle', color: '#123456' }, 'printer-tag'), /Tag not found/)
})

test('creating freeform tags binds identical names to independent entity catalogs', async () => {
  const kinds: unknown[] = []
  stub(prisma.workspaceTag, 'create', async (args: Prisma.WorkspaceTagCreateArgs) => {
    kinds.push(args.data.entityKind)
    assert.equal(args.data.name, 'Phaetus Conch')
    assert.equal(args.data.group, 'Nozzle')
    return args.data
  })
  for (const kind of ['printer', 'file', 'spool'] as const) {
    await saveWorkspaceTag('w1', kind, { name: 'Phaetus Conch', group: 'Nozzle', color: '#123456' })
  }
  assert.deepEqual(kinds, ['printer', 'file', 'spool'])
})
