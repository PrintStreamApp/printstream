process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { rootPrisma } from './prisma.js'
import { pruneDeletedWorkspaces } from './workspace-cleanup.js'

/**
 * The sweep is the only irreversible half of workspace deletion — everything a
 * user clicks is recoverable, and this is what stops being so. Its window and
 * its failure isolation are therefore the parts worth pinning.
 */
const stub = usePrismaStubs()
const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-06T00:00:00.000Z')

test('only workspaces past the retention window are swept', async () => {
  let where: { deletedAt: { not: null, lte: Date } } | undefined
  stub(rootPrisma.workspace, 'findMany', async (args: { where: typeof where }) => {
    where = args.where
    return []
  })

  await pruneDeletedWorkspaces(NOW)

  // A deleted workspace still inside its window is restorable, so the sweep
  // must not be able to see it at all — the filter is the guarantee.
  assert.ok(where)
  assert.equal(where.deletedAt.not, null)
  assert.equal(NOW.getTime() - where.deletedAt.lte.getTime(), 30 * DAY)
})

test('one wedged workspace does not park the rest of the sweep', async () => {
  const deleted: string[] = []
  stub(rootPrisma.workspace, 'findMany', async () => ([
    { id: 'ws-broken', name: 'Broken' },
    { id: 'ws-fine', name: 'Fine' }
  ]))
  stub(rootPrisma.workspace, 'delete', async ({ where }: { where: { id: string } }) => {
    if (where.id === 'ws-broken') throw new Error('bridge offline')
    deleted.push(where.id)
    return {}
  })

  const result = await pruneDeletedWorkspaces(NOW)

  // These are independent: one failure must not let every other deleted
  // workspace accumulate behind it, retried forever and never removed.
  assert.deepEqual(deleted, ['ws-fine'])
  assert.equal(result.removed, 1)
  assert.equal(result.failed, 1)
})

test('a deleted workspace is scoped out by the shared predicate', async () => {
  const { visibleWorkspacesWhere, visibleWorkspaceScope } = await import('./workspace-visibility.js')

  // The predicate pins `deletedAt` even against a caller that tries to set it,
  // so no call site can widen the scope by accident — which is the failure mode
  // a per-site filter invites.
  assert.deepEqual(visibleWorkspacesWhere({ slug: 'shop' }), { slug: 'shop', deletedAt: null })
  assert.deepEqual(
    visibleWorkspacesWhere({ id: 'ws-1', deletedAt: { not: null } } as { id: string, deletedAt: unknown }),
    { id: 'ws-1', deletedAt: null }
  )
  assert.deepEqual(visibleWorkspaceScope, { deletedAt: null })
})
