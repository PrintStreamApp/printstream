import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveImpliedPermissions,
  getPermissionPrerequisites,
  getPermissionDependents,
  type Permission
} from './permissions.js'

test('resolveImpliedPermissions returns empty for permissions with no prerequisites', () => {
  const implied = resolveImpliedPermissions(['printers.view'])
  assert.deepEqual(implied, [])
})

test('resolveImpliedPermissions returns direct prerequisites', () => {
  const implied = resolveImpliedPermissions(['printers.control'])
  assert.deepEqual(implied.sort(), ['printers.view'])
})

test('resolveImpliedPermissions resolves transitive prerequisites', () => {
  const implied = resolveImpliedPermissions(['auth.users.revokeSessions'])
  const sorted = implied.sort()
  assert.ok(sorted.includes('auth.users.viewSessions'))
  assert.ok(sorted.includes('auth.users.view'))
})

test('resolveImpliedPermissions does not duplicate already-selected permissions', () => {
  const implied = resolveImpliedPermissions(['printers.control', 'printers.view'])
  assert.deepEqual(implied, [])
})

test('resolveImpliedPermissions handles multi-parent prerequisites', () => {
  const implied = resolveImpliedPermissions(['prints.dispatch'])
  const sorted = implied.sort()
  assert.ok(sorted.includes('printers.view'))
  assert.ok(sorted.includes('library.view'))
})

test('resolveImpliedPermissions handles deep chains', () => {
  // auth.users.revokeSessions -> auth.users.viewSessions -> auth.users.view -> auth.access.view
  const implied = resolveImpliedPermissions(['auth.users.revokeSessions'])
  const sorted = implied.sort()
  assert.ok(sorted.includes('auth.access.view'))
  assert.ok(sorted.includes('auth.users.viewSessions'))
  assert.ok(sorted.includes('auth.users.view'))
})

test('resolveImpliedPermissions resolves passkey permissions through user view', () => {
  const implied = resolveImpliedPermissions(['auth.passkeys.edit'])
  const sorted = implied.sort()
  assert.ok(sorted.includes('auth.access.view'))
  assert.ok(sorted.includes('auth.passkeys.view'))
  assert.ok(sorted.includes('auth.users.view'))
})

test('resolveImpliedPermissions resolves auth management views through access view', () => {
  const implied = resolveImpliedPermissions(['auth.roles.edit'])
  const sorted = implied.sort()
  assert.ok(sorted.includes('auth.roles.view'))
  assert.ok(sorted.includes('auth.access.view'))
})

test('resolveImpliedPermissions requires tenant management before tenant disablement', () => {
  const implied = resolveImpliedPermissions(['tenants.disable'])

  assert.deepEqual(implied, ['tenants.manage'])
})

test('getPermissionPrerequisites returns direct parents only', () => {
  const prereqs = getPermissionPrerequisites('auth.users.revokeSessions')
  assert.deepEqual([...prereqs].sort(), ['auth.users.viewSessions'])
})

test('getPermissionPrerequisites returns the normalized passkey chain', () => {
  assert.deepEqual([...getPermissionPrerequisites('auth.users.view')], ['auth.access.view'])
  assert.deepEqual([...getPermissionPrerequisites('auth.roles.view')], ['auth.access.view'])
  assert.deepEqual([...getPermissionPrerequisites('auth.serviceAccounts.view')], ['auth.access.view'])
  assert.deepEqual([...getPermissionPrerequisites('auth.passkeys.view')], ['auth.users.view'])
  assert.deepEqual([...getPermissionPrerequisites('auth.passkeys.edit')], ['auth.passkeys.view'])
  assert.deepEqual([...getPermissionPrerequisites('auth.passkeys.revoke')], ['auth.passkeys.view'])
})

test('getPermissionPrerequisites returns empty for root permissions', () => {
  const prereqs = getPermissionPrerequisites('printers.view')
  assert.deepEqual([...prereqs], [])
})

test('getPermissionDependents returns children of a permission', () => {
  const dependents = getPermissionDependents('printers.view' as Permission)
  assert.ok(dependents.includes('printers.control'))
  assert.ok(dependents.includes('printers.manage'))
  assert.ok(dependents.includes('camera.view'))
})

test('getPermissionDependents returns passkey children from the normalized chain', () => {
  const accessDependents = getPermissionDependents('auth.access.view' as Permission)
  const userDependents = getPermissionDependents('auth.users.view' as Permission)
  const passkeyDependents = getPermissionDependents('auth.passkeys.view' as Permission)

  assert.ok(accessDependents.includes('auth.users.view'))
  assert.ok(accessDependents.includes('auth.roles.view'))
  assert.ok(accessDependents.includes('auth.serviceAccounts.view'))
  assert.ok(userDependents.includes('auth.passkeys.view'))
  assert.ok(passkeyDependents.includes('auth.passkeys.edit'))
  assert.ok(passkeyDependents.includes('auth.passkeys.revoke'))
})
