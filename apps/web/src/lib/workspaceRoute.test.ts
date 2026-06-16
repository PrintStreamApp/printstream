import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPlatformWorkspacePath,
  buildTenantWorkspacePath,
  buildWorkspaceSelectionPath,
  isPlatformWorkspacePath,
  isTenantWorkspaceCandidatePath,
  parseWorkspacePathname
} from './workspaceRoute'

test('buildWorkspaceSelectionPath returns the chooser route', () => {
  assert.equal(buildWorkspaceSelectionPath(), '/workspaces')
})

test('buildPlatformWorkspacePath returns the explicit platform route', () => {
  assert.equal(buildPlatformWorkspacePath(), '/platform')
})

test('buildTenantWorkspacePath prefixes tenant routes with the workspace slug', () => {
  assert.equal(buildTenantWorkspacePath('Alpha', '/printers'), '/workspaces/alpha/printers')
  assert.equal(buildTenantWorkspacePath('alpha', '/'), '/workspaces/alpha')
  assert.equal(buildTenantWorkspacePath('alpha', '/jobs?filter=mine'), '/workspaces/alpha/jobs?filter=mine')
})

test('parseWorkspacePathname strips the tenant slug from scoped routes', () => {
  assert.deepEqual(parseWorkspacePathname('/workspaces/alpha'), {
    tenantSlug: 'alpha',
    appPathname: '/'
  })
  assert.deepEqual(parseWorkspacePathname('/workspaces/alpha/settings/notifications'), {
    tenantSlug: 'alpha',
    appPathname: '/settings/notifications'
  })
  assert.deepEqual(parseWorkspacePathname('/printers'), {
    tenantSlug: null,
    appPathname: '/printers'
  })
})

test('isTenantWorkspaceCandidatePath excludes global routes and includes tenant content routes', () => {
  assert.equal(isTenantWorkspaceCandidatePath('/'), true)
  assert.equal(isTenantWorkspaceCandidatePath('/jobs'), true)
  assert.equal(isTenantWorkspaceCandidatePath('/orders/templates'), true)
  assert.equal(isTenantWorkspaceCandidatePath('/account'), true)
  assert.equal(isTenantWorkspaceCandidatePath('/auth'), false)
  assert.equal(isTenantWorkspaceCandidatePath('/platform/settings'), false)
  assert.equal(isTenantWorkspaceCandidatePath('/workspaces'), false)
})

test('isPlatformWorkspacePath detects platform-owned routes', () => {
  assert.equal(isPlatformWorkspacePath('/platform'), true)
  assert.equal(isPlatformWorkspacePath('/platform/settings'), true)
  assert.equal(isPlatformWorkspacePath('/'), false)
  assert.equal(isPlatformWorkspacePath('/workspaces/alpha'), false)
})