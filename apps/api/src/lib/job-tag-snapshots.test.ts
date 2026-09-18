process.env.NODE_ENV = 'test'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JobTag } from '@printstream/shared'
import { captureJobTags, historicalTag } from './job-tag-snapshots.js'
import { rootPrisma } from './prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

const stub = usePrismaStubs()
const tag: JobTag = { id: 't', entityKind: 'spool', name: 'Dry', group: 'Condition', color: '#123456' }

test('capture explicitly scopes sources and freezes all display fields', async () => {
  stub(rootPrisma.workspaceTag, 'findMany', async (args: { where: unknown; select: unknown }) => {
    assert.deepEqual(args.where, { workspaceId: 'w1', OR: [
      { entityKind: 'printer', printers: { some: { id: 'p1', workspaceId: 'w1' } } },
      { entityKind: 'file', files: { some: { id: { in: ['f1'] }, workspaceId: 'w1' } } }
    ] })
    assert.deepEqual(args.select, { id: true, entityKind: true, name: true, group: true, color: true })
    return [tag]
  })
  assert.deepEqual(await captureJobTags(rootPrisma, 'w1', { printerId: 'p1', fileIds: ['f1'] }), [tag])
  assert.notEqual(historicalTag(tag).id, historicalTag({ ...tag, color: '#abcdef' }).id)
})

