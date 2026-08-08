import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPlatformWorkspacePath,
  buildWorkspacePath,
  buildWorkspaceSelectionPath,
  isPlatformWorkspacePath,
  isWorkspaceCandidatePath,
  parseWorkspacePathname
} from './workspaceRoute'

test('buildWorkspaceSelectionPath returns the chooser route', () => {
  assert.equal(buildWorkspaceSelectionPath(), '/workspaces')
})

test('buildPlatformWorkspacePath returns the explicit platform route', () => {
  assert.equal(buildPlatformWorkspacePath(), '/platform')
})

test('buildWorkspacePath prefixes workspace routes with the workspace slug', () => {
  assert.equal(buildWorkspacePath('Alpha', '/printers'), '/workspaces/alpha/printers')
  assert.equal(buildWorkspacePath('alpha', '/'), '/workspaces/alpha')
  assert.equal(buildWorkspacePath('alpha', '/jobs?filter=mine'), '/workspaces/alpha/jobs?filter=mine')
})

test('parseWorkspacePathname strips the workspace slug from scoped routes', () => {
  assert.deepEqual(parseWorkspacePathname('/workspaces/alpha'), {
    workspaceSlug: 'alpha',
    appPathname: '/'
  })
  assert.deepEqual(parseWorkspacePathname('/workspaces/alpha/settings/notifications'), {
    workspaceSlug: 'alpha',
    appPathname: '/settings/notifications'
  })
  assert.deepEqual(parseWorkspacePathname('/printers'), {
    workspaceSlug: null,
    appPathname: '/printers'
  })
})

test('isWorkspaceCandidatePath excludes global routes and includes workspace content routes', () => {
  assert.equal(isWorkspaceCandidatePath('/'), true)
  assert.equal(isWorkspaceCandidatePath('/jobs'), true)
  assert.equal(isWorkspaceCandidatePath('/orders/templates'), true)
  assert.equal(isWorkspaceCandidatePath('/account'), true)
  assert.equal(isWorkspaceCandidatePath('/auth'), false)
  assert.equal(isWorkspaceCandidatePath('/platform/settings'), false)
  assert.equal(isWorkspaceCandidatePath('/workspaces'), false)
})

test('isPlatformWorkspacePath detects platform-owned routes', () => {
  assert.equal(isPlatformWorkspacePath('/platform'), true)
  assert.equal(isPlatformWorkspacePath('/platform/settings'), true)
  assert.equal(isPlatformWorkspacePath('/'), false)
  assert.equal(isPlatformWorkspacePath('/workspaces/alpha'), false)
})