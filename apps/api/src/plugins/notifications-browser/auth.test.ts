process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { withBrowserNotificationsApp } from './test-harness.js'

test.afterEach(() => {
  mock.restoreAll()
})

test('browser notification settings require authentication once auth is enabled', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('a workspace member enrols a device without settings.manage', async () => {
  // Enabling notifications on YOUR OWN device is per-actor, per-device state,
  // not workspace configuration: gating it on `settings.manage` made
  // background notifications an accidentally admin-only feature, so a
  // Manager, Operator or Viewer could never be alerted about their own print.
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/subscription',
          keys: {
            p256dh: 'p256dh-key',
            auth: 'auth-key'
          }
        }
      })
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { subscriptions: 1 })

    // …and the device-state routes that pair with it.
    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser`)
    assert.equal(readResponse.status, 200)
    assert.equal((await readResponse.json() as { subscriptions: number }).subscriptions, 1)

    const lookupResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example.test/subscription' })
    })
    assert.equal(lookupResponse.status, 200)
    assert.deepEqual(await lookupResponse.json(), { registered: true })
  })
})

test('a non-member cannot enrol a device or read the scope, permission or not', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'outsider-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/subscription',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
        }
      })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: 'Browser notifications are only available to workspace members.'
    })

    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser`)
    assert.equal(readResponse.status, 403)
  }, { workspaceMembers: ['user-1'] })
})

test('one member cannot unregister another member device', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/user-1-device',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
        }
      })
    })

    // A second member of the same workspace, holding user-1's endpoint.
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-test-actor': 'user-2' },
      body: JSON.stringify({ endpoint: 'https://push.example.test/user-1-device' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'That subscription belongs to another account.' })
  }, { workspaceMembers: ['user-1', 'user-2'] })
})

test('a signed-out caller gets the same 401 from subscribe as from its sibling routes', async () => {
  // `POST /subscriptions` cannot call the shared guard (it self-heals a stale
  // entry first), so it is the one route that could drift into answering a
  // different status for the identical request.
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const subscribeResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/subscription',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
        }
      })
    })
    assert.equal(subscribeResponse.status, 401)
    assert.deepEqual(await subscribeResponse.json(), { error: 'Authentication required.' })

    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser`)
    assert.equal(readResponse.status, 401)
  })
})

test('subscription lookup answers for the caller, not the scope', async () => {
  // Two accounts share a browser profile, so they share one push endpoint.
  // Reporting the other account's registration made the panel offer "Disable",
  // which the delete then refused, stranding the user with no way to enrol.
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const enrol = (actor: string) => fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-actor': actor },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/shared-profile',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
        }
      })
    })
    const lookup = (actor: string) => fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-actor': actor },
      body: JSON.stringify({ endpoint: 'https://push.example.test/shared-profile' })
    })

    assert.equal((await enrol('user-2')).status, 201)
    assert.deepEqual(await (await lookup('user-2')).json(), { registered: true })
    assert.deepEqual(await (await lookup('user-1')).json(), { registered: false })

    // …and user-1 can still take the endpoint over rather than being stuck.
    assert.equal((await enrol('user-1')).status, 201)
    assert.deepEqual(await (await lookup('user-1')).json(), { registered: true })
  }, { workspaceMembers: ['user-1', 'user-2'] })
})

test('a legacy subscription with no actor key is quarantined until re-enrolment', async () => {
  // The old row has no owner to membership-check, so it must neither count nor receive. A normal
  // enrolment of the same endpoint replaces it with an actor-bound row and restores delivery.
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl, settings }) => {
    settings.set('workspace:test-workspace:subscriptions', JSON.stringify([{
      endpoint: 'https://push.example.test/legacy',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      createdAt: '2026-01-01T00:00:00.000Z'
    }]))

    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser`)
    assert.equal((await readResponse.json() as { subscriptions: number }).subscriptions, 0)

    const lookup = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example.test/legacy' })
    })
    assert.deepEqual(await lookup.json(), { registered: false })

    const enrol = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: {
        endpoint: 'https://push.example.test/legacy',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
      } })
    })
    assert.equal(enrol.status, 201)
    assert.equal((await enrol.json() as { subscriptions: number }).subscriptions, 1)
  })
})

test('browser notification dismissals require an authenticated actor', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/dismissals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'printer:p1:job' })
    })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('browser notification subscriptions can be managed by settings managers', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser`)
    const readBody = await readResponse.json() as { publicKey: string; subscriptions: number }

    assert.equal(readResponse.status, 200)
    assert.equal(typeof readBody.publicKey, 'string')
    assert.equal(readBody.publicKey.length > 0, true)
    assert.equal(readBody.subscriptions, 0)

    const subscribeResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/subscription',
          keys: {
            p256dh: 'p256dh-key',
            auth: 'auth-key'
          }
        }
      })
    })

    assert.equal(subscribeResponse.status, 201)
    assert.deepEqual(await subscribeResponse.json(), { subscriptions: 1 })
  })
})

test('browser notification subscriptions reject non-members with settings.manage (support access)', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'platform-user-1', isPlatformUser: true },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const subscribeResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/subscription',
          keys: {
            p256dh: 'p256dh-key',
            auth: 'auth-key'
          }
        }
      })
    })

    assert.equal(subscribeResponse.status, 403)
    assert.deepEqual(await subscribeResponse.json(), {
      error: 'Browser notifications are only available to workspace members.'
    })

    // Support access does not extend to the workspace's device list either.
    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser`)
    assert.equal(readResponse.status, 403)
  }, { workspaceMembers: [] })
})

// Which devices a dismissal actually reaches is pinned end-to-end in
// `dismissals.test.ts`, against the endpoints signed for rather than the
// delivery method called: the defect that motivated it was a fan-out into the
// wrong SCOPE, which a method-level assertion still reports as a call.

test('browser notification dismissals validate their payload', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/dismissals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Invalid dismissal payload' })
  })
})
