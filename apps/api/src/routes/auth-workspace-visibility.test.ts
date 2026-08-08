process.env.NODE_ENV = 'test'

/**
 * A soft-deleted workspace must not reach the chooser.
 *
 * Found by actually signing in: a workspace deleted the day before was still
 * listed, and still enterable. The visibility audit had fixed every list that
 * queries `Workspace` directly and missed the two that reach it THROUGH a
 * membership — `authWorkspaceMembership.findMany({ select: { workspace } })`
 * names no workspace conditions at all, so nothing looked unfiltered.
 *
 * That is worse than not soft-deleting: the workspace is gone from billing,
 * People and platform metrics, but still offered as somewhere to work.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { rootPrisma } from '../lib/prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { visibleWorkspacesWhere } from '../lib/workspace-visibility.js'

const stub = usePrismaStubs()
afterEach(() => undefined)

test('the membership lookup scopes to visible workspaces', async () => {
  // Asserts the WHERE the loader must send. A membership query carries its
  // workspace conditions nested, which is exactly why the omission was
  // invisible to a reviewer scanning for `deletedAt`.
  let received: unknown = null
  stub(rootPrisma.authWorkspaceMembership, 'findMany', (async (args: { where?: unknown }) => {
    received = args.where
    return []
  }) as never)

  // The REAL loader, not a mirror of it: a copy in the test would keep passing
  // after the original regressed, which is the failure this test exists to stop.
  const { loadMembershipWorkspaces } = await import('./auth.js')
  await loadMembershipWorkspaces('user_1')

  assert.deepEqual(received, {
    userId: 'user_1',
    loginDisabled: false,
    workspace: visibleWorkspacesWhere({})
  })
})

test('the visible scope is exactly "not deleted"', () => {
  // Pinned separately so a change to the shared predicate cannot silently widen
  // what the chooser offers.
  assert.deepEqual(visibleWorkspacesWhere({}), { deletedAt: null })
})
