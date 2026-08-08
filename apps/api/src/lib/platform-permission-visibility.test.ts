process.env.NODE_ENV = 'test'

/**
 * Built-in platform grants must survive the platform-context filter.
 *
 * Effective permissions are the group's grants passed through
 * `filterPermissionsForPlatformContext`, which keeps only the platform-visible
 * set. A permission seeded onto a role but missing from that set is granted and
 * then silently dropped — the operator holds it in the database and is refused
 * by the route, which reads as a 403 nobody can explain from either side.
 *
 * This is not hypothetical: while auditing, the running dev API answered 403 on
 * the account routes with the grants present in its own database. That turned
 * out to be a stale build in a long-lived process rather than a code fault, but
 * nothing in the suite would have distinguished the two — this test is what
 * tells them apart, because it fails only when the SETS genuinely disagree.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterPermissionsForPlatformContext } from '@printstream/shared'
import { builtInPlatformAuthGroupSeeds } from './default-auth-groups.js'

test('every built-in platform grant is visible in platform context', () => {
  const dropped: string[] = []

  for (const seed of builtInPlatformAuthGroupSeeds) {
    const kept = new Set(filterPermissionsForPlatformContext(seed.permissions))
    for (const permission of seed.permissions) {
      if (!kept.has(permission)) dropped.push(`${seed.key}: ${permission}`)
    }
  }

  assert.deepEqual(
    dropped,
    [],
    'these are granted by a built-in role and then filtered away, so the route '
      + `refuses a holder who has them: ${dropped.join(', ')}`
  )
})

test('the account and licence grants specifically reach the roles that need them', () => {
  // The control: a filter that dropped everything would satisfy the test above
  // only if the seeds were empty too.
  const manager = builtInPlatformAuthGroupSeeds.find((seed) => seed.key === 'platform_manager')
  assert.ok(manager)
  const kept = filterPermissionsForPlatformContext(manager.permissions)
  for (const permission of ['accounts.view', 'accounts.create', 'accounts.people.manage', 'licenses.issue']) {
    assert.ok(kept.includes(permission as never), `Manager must keep ${permission} after filtering`)
  }
})
