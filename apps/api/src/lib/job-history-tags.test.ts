process.env.NODE_ENV = 'test'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JobHistoryEntry, JobTag, SlicingJob } from '@printstream/shared'
import { jobHistoryTagMatcher, readJobHistoryTags, jobHistoryTagCatalog } from './job-history-tags.js'
import { prisma } from './prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { historicalTag } from './job-tag-snapshots.js'

const stub = usePrismaStubs()
const tag: JobTag = { id: 'tag', entityKind: 'file', name: 'Conch', group: 'Nozzle', color: '#123456' }
const entry = { kind: 'print', printJob: { id: 'j1' } } as JobHistoryEntry

test('history needs no live tag, file, printer, spool or usage rows after snapshots are recorded', async () => {
  stub(prisma.printJob, 'findMany', async (args: { where: unknown }) => {
    assert.deepEqual(args.where, { workspaceId: 'w1', finishedAt: { not: null } })
    return [{ id: 'j1', tagSnapshotJson: JSON.stringify({ tags: [tag], spoolIds: ['deleted-spool'] }) }]
  })
  const tags = await readJobHistoryTags('w1', [])
  assert.equal(jobHistoryTagMatcher(tags, 'conch')(entry), true)
  assert.equal(jobHistoryTagMatcher(tags, 'nozzle')(entry), true)
  assert.equal(jobHistoryTagMatcher(tags, '', [historicalTag(tag).id])(entry), true)
  assert.equal(jobHistoryTagMatcher(tags, '', ['unknown'])(entry), false)
  assert.deepEqual(jobHistoryTagCatalog(tags), [historicalTag(tag)])
})

test('all selected tags must match, including across catalogs; renaming cannot rewrite an older job', () => {
  const printer = historicalTag({ ...tag, entityKind: 'printer' })
  const file = historicalTag(tag)
  const renamed = historicalTag({ ...tag, name: 'New nozzle', color: '#abcdef' })
  const tags = new Map([['print:j1', [printer, file]], ['print:j2', [renamed]]])
  assert.equal(jobHistoryTagMatcher(tags, '', [printer.id, file.id])(entry), true)
  assert.equal(jobHistoryTagMatcher(tags, '', [printer.id, renamed.id])(entry), false)
  assert.equal(jobHistoryTagMatcher(tags, 'New nozzle')(entry), false)
  assert.equal(jobHistoryTagCatalog(tags).length, 3)
})

test('legacy jobs stay unknown and slicing history uses only its captured tags', async () => {
  stub(prisma.printJob, 'findMany', async () => [{ id: 'j1', tagSnapshotJson: null }])
  const slicing = { id: 's1', tagSnapshot: [tag] } as SlicingJob
  const tags = await readJobHistoryTags('w1', [slicing])
  assert.equal(jobHistoryTagMatcher(tags, 'Conch')(entry), false)
  assert.equal(jobHistoryTagMatcher(tags, 'Conch')({ kind: 'slicing', slicingJob: slicing }), true)
})
