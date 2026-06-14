import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canSendAuthUserInvite,
  deriveAuthHealthSignals,
  hasAuthProfileChanges,
  normalizeAuthProfileDraft,
  resolveShellIdentity
} from './authUi'

test('normalizeAuthProfileDraft trims profile fields and treats blank display names as null', () => {
  assert.deepEqual(
    normalizeAuthProfileDraft({
      email: '  admin@example.com  ',
      displayName: '   '
    }),
    {
      email: 'admin@example.com',
      displayName: null
    }
  )
})

test('hasAuthProfileChanges ignores noop whitespace edits in the account profile editor', () => {
  assert.equal(
    hasAuthProfileChanges(
      { email: 'admin@example.com', displayName: 'Primary Admin' },
      { email: ' admin@example.com ', displayName: ' Primary Admin ' }
    ),
    false
  )
})

test('hasAuthProfileChanges detects an account email change', () => {
  assert.equal(
    hasAuthProfileChanges(
      { email: 'member@example.com', displayName: 'Member' },
      { email: 'updated.member@example.com', displayName: 'Member' }
    ),
    true
  )
})

test('canSendAuthUserInvite blocks invite links for disabled users', () => {
  assert.equal(canSendAuthUserInvite({ loginDisabled: true }), false)
  assert.equal(canSendAuthUserInvite({ loginDisabled: false }), true)
})

test('resolveShellIdentity prefers display names and falls back to email', () => {
  assert.deepEqual(
    resolveShellIdentity({
      type: 'user',
      userId: 'user-1',
      isPlatformUser: false,
      displayName: 'Primary Admin',
      email: 'admin@example.com'
    }),
    {
      primary: 'Primary Admin',
      secondary: 'admin@example.com'
    }
  )

  assert.deepEqual(
    resolveShellIdentity({
      type: 'user',
      userId: 'user-2',
      isPlatformUser: false,
      email: 'viewer@example.com'
    }),
    {
      primary: 'viewer@example.com',
      secondary: null
    }
  )
})

test('deriveAuthHealthSignals highlights admin coverage, local-auth users without passkeys, and disabled users', () => {
  assert.deepEqual(
    deriveAuthHealthSignals([
      {
        id: 'user-1',
        email: 'admin@example.com',
        displayName: 'Primary Admin',
        loginDisabled: false,
        isPlatformUser: false,
        groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
        passkeyCount: 2,
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      },
      {
        id: 'user-2',
        email: 'member@example.com',
        displayName: 'Member',
        loginDisabled: false,
        isPlatformUser: false,
        groups: [{ id: 'group-viewer', key: 'viewer', name: 'Viewer' }],
        passkeyCount: 0,
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      },
      {
        id: 'user-3',
        email: 'disabled@example.com',
        displayName: 'Disabled User',
        loginDisabled: true,
        isPlatformUser: false,
        groups: [{ id: 'group-viewer', key: 'viewer', name: 'Viewer' }],
        passkeyCount: 0,
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      }
    ]),
    [
      {
        id: 'last-enabled-admin',
        color: 'warning',
        title: 'Only one enabled Admin remains',
        detail: 'Keep a second Admin account available so auth recovery does not depend on a single user.'
      },
      {
        id: 'email-code-only-users',
        color: 'warning',
        title: '1 enabled user has no local passkeys',
        detail: 'For local-auth users, emailed one-time codes remain the only local sign-in and recovery path until a passkey is added.'
      },
      {
        id: 'disabled-users',
        color: 'neutral',
        title: '1 user currently has sign-in disabled',
        detail: 'Review disabled accounts periodically so temporary lockouts do not become permanent access drift.'
      }
    ]
  )
})

test('deriveAuthHealthSignals skips local-auth guidance when local auth is disabled', () => {
  assert.deepEqual(
    deriveAuthHealthSignals([
      {
        id: 'user-1',
        email: 'admin@example.com',
        displayName: 'Primary Admin',
        loginDisabled: false,
        isPlatformUser: false,
        groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
        passkeyCount: 0,
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      }
    ], { localAuthEnabled: false }),
    [{
      id: 'last-enabled-admin',
      color: 'warning',
      title: 'Only one enabled Admin remains',
      detail: 'Keep a second Admin account available so auth recovery does not depend on a single user.'
    }]
  )
})