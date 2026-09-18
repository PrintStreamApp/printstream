process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import webpush from 'web-push'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { withBrowserNotificationsApp } from './test-harness.js'

const ADMIN: RequestAuthContext = {
  authEnabled: true,
  actor: { type: 'user', userId: 'user-1' },
  permissions: [SETTINGS_MANAGE_PERMISSION],
  runtimePolicy: { demoMode: false }
} as RequestAuthContext

/** A member with no `settings.manage`: they still dismiss their own notifications. */
const MEMBER: RequestAuthContext = {
  authEnabled: true,
  actor: { type: 'user', userId: 'user-1' },
  permissions: [],
  runtimePolicy: { demoMode: false }
} as RequestAuthContext

const DISMISSALS_PATH = '/api/plugins/notifications-browser/dismissals'

// `captureSentPushes` patches the shared `webpush` module object; without this
// each test stacks another mock on the last and leaves it patched for the
// process. `auth.test.ts` alongside does the same, and setup that differs
// between two suites for one plugin is what makes the next test added here
// fail for an unrelated-looking reason.
test.afterEach(() => {
  mock.restoreAll()
})

function subscribe(baseUrl: string, workspace: string, endpoint: string) {
  return fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-workspace': workspace },
    body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } } })
  })
}

function dismiss(baseUrl: string, workspace: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${DISMISSALS_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-workspace': workspace },
    body: JSON.stringify(body)
  })
}

/**
 * Capture the endpoints a fan-out actually signed for, with the payload each
 * received. Asserting here rather than on the delivery method called is
 * deliberate: the defect this file pins was a fan-out that picked the wrong
 * SCOPE, which every higher-level assertion still reports as a call.
 */
function captureSentPushes() {
  const sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
  mock.method(webpush, 'sendNotification', async (subscription: { endpoint: string }, body: string) => {
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) as Record<string, unknown> })
    return { statusCode: 201, body: '', headers: {} }
  })
  return sent
}

test('a dismissal reaches the actor devices in every scope, not just the request workspace', async () => {
  const sent = captureSentPushes()

  await withBrowserNotificationsApp(ADMIN, async ({ baseUrl }) => {
    // Two of this user's devices, both enabled in the same workspace.
    assert.equal((await subscribe(baseUrl, 'workspace-a', 'https://push.example.test/phone')).status, 201)
    assert.equal((await subscribe(baseUrl, 'workspace-a', 'https://push.example.test/desktop')).status, 201)

    // The service worker sends no workspace hint, so the request resolves to
    // whatever the shared workspace-context cookie last said. For a platform
    // user or a multi-workspace member that is the platform scope, where a
    // workspace device can never be registered.
    const response = await dismiss(baseUrl, 'platform', { notificationId: 'notification-1', tag: 'printer:p1:job' })
    assert.equal(response.status, 202)
  })

  assert.deepEqual(sent.map((entry) => entry.endpoint).sort(), [
    'https://push.example.test/desktop',
    'https://push.example.test/phone'
  ])
  assert.deepEqual(sent[0]?.payload, {
    type: 'dismiss',
    notificationId: 'notification-1',
    tag: 'printer:p1:job'
  })
})

test('a dismissal is not echoed back to the device that reported it', async () => {
  const sent = captureSentPushes()

  await withBrowserNotificationsApp(ADMIN, async ({ baseUrl }) => {
    await subscribe(baseUrl, 'workspace-a', 'https://push.example.test/phone')
    await subscribe(baseUrl, 'workspace-a', 'https://push.example.test/desktop')

    const response = await dismiss(baseUrl, 'workspace-a', {
      tag: 'printer:p1:job',
      endpoint: 'https://push.example.test/phone'
    })
    assert.equal(response.status, 202)
  })

  assert.deepEqual(sent.map((entry) => entry.endpoint), ['https://push.example.test/desktop'])
})

test('a dismissal reaches a device registered in a different workspace, once', async () => {
  const sent = captureSentPushes()

  await withBrowserNotificationsApp(ADMIN, async ({ baseUrl }) => {
    // One device enabled in two workspaces holds ONE endpoint, stored per scope.
    await subscribe(baseUrl, 'workspace-a', 'https://push.example.test/desktop')
    await subscribe(baseUrl, 'workspace-b', 'https://push.example.test/desktop')
    await subscribe(baseUrl, 'workspace-b', 'https://push.example.test/tablet')

    const response = await dismiss(baseUrl, 'workspace-a', { tag: 'printer:p1:job' })
    assert.equal(response.status, 202)
  })

  assert.deepEqual(sent.map((entry) => entry.endpoint).sort(), [
    'https://push.example.test/desktop',
    'https://push.example.test/tablet'
  ])
})

test('a dismissal never reaches another actor devices', async () => {
  const sent = captureSentPushes()

  await withBrowserNotificationsApp(ADMIN, async ({ baseUrl }) => {
    await subscribe(baseUrl, 'workspace-a', 'https://push.example.test/mine')
    await dismiss(baseUrl, 'workspace-a', { tag: 'printer:p1:job' })
  }, { workspaceMembers: ['user-1', 'user-2'] })

  assert.deepEqual(sent.map((entry) => entry.endpoint), ['https://push.example.test/mine'])
})

test('an auth-disabled install enrols devices but keeps dismissals local', async () => {
  // No auth provider means no person identity. The server may broadcast
  // workspace alerts to both devices, but one operator dismissing an alert
  // must not clear it for another person using the same installation.
  const sent = captureSentPushes()

  await withBrowserNotificationsApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  } as RequestAuthContext, async ({ baseUrl }) => {
    assert.equal((await subscribe(baseUrl, 'workspace-a', 'https://push.example.test/phone')).status, 201)
    assert.equal((await subscribe(baseUrl, 'workspace-a', 'https://push.example.test/desktop')).status, 201)

    const response = await dismiss(baseUrl, 'workspace-a', {
      tag: 'printer:p1:job',
      endpoint: 'https://push.example.test/phone'
    })
    assert.equal(response.status, 202)
  })

  assert.deepEqual(sent, [])
})

test('dismissing your own notification does not require settings.manage', async () => {
  const sent = captureSentPushes()

  await withBrowserNotificationsApp(MEMBER, async ({ baseUrl }) => {
    await subscribe(baseUrl, 'workspace-a', 'https://push.example.test/phone')

    const response = await dismiss(baseUrl, 'workspace-a', { tag: 'printer:p1:job' })
    assert.equal(response.status, 202)
  })

  assert.deepEqual(sent.map((entry) => entry.endpoint), ['https://push.example.test/phone'])
})
