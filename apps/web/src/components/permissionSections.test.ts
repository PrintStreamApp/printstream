/**
 * Where each permission lands in the role editor.
 *
 * "Other" is the fallback, and anything sitting there is a permission whose
 * home nobody chose, which is how an operator ends up scrolling past the
 * section that decides authority over customer money to find it at the bottom
 * with no heading of its own.
 *
 * Asserts against the whole catalog rather than a list of examples, so a
 * permission added later cannot quietly land in the fallback.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { permissionDefinitions, permissionValues, type Permission } from '@printstream/shared'
import { buildPermissionSections, permissionSectionTitle } from './permissionMatrix'

test('no permission falls through to Other', () => {
  const orphans = (permissionValues as readonly Permission[])
    .filter((permission) => permissionSectionTitle(permission) === 'Other')
  assert.deepEqual(orphans, [], `these permissions have no section: ${orphans.join(', ')}`)
})

test('accounts, licences and billing share one section', () => {
  for (const permission of [
    'accounts.view',
    'accounts.create',
    'accounts.people.manage',
    'licenses.view',
    'licenses.revealKey',
    'licenses.issue',
    'licenses.revoke',
    'billing.manage'
  ] as Permission[]) {
    assert.equal(permissionSectionTitle(permission), 'Accounts & Licensing', permission)
  }
})

test('workspace administration stays under Platform, not with the money', () => {
  assert.equal(permissionSectionTitle('workspaces.manage'), 'Platform')
  assert.equal(permissionSectionTitle('workspaces.disable'), 'Platform')
})

test('every section the catalog produces is one the editor orders', () => {
  // `buildPermissionSections` drops any group whose title is not in its own
  // order list, so a new title without an entry would vanish from the UI
  // silently rather than render out of place.
  const rendered = buildPermissionSections([...permissionDefinitions]).map((section) => section.title)
  const expected = new Set(permissionDefinitions.map((definition) => permissionSectionTitle(definition.key)))
  for (const title of expected) {
    assert.ok(rendered.includes(title), `section "${title}" is produced but never rendered`)
  }
})
