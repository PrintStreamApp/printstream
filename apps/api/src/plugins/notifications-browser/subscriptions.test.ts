process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { withBrowserNotificationsApp } from './test-harness.js'

const AUTH: RequestAuthContext = {
  authEnabled: true,
  actor: { type: 'user', userId: 'user-1' },
  permissions: [SETTINGS_MANAGE_PERMISSION],
  runtimePolicy: { demoMode: false }
} as RequestAuthContext

const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/device-1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
}

function subscribe(baseUrl: string, workspace: string) {
  return fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-workspace': workspace },
    body: JSON.stringify({ subscription: SUBSCRIPTION })
  })
}

function lookup(baseUrl: string, workspace: string, endpoint = SUBSCRIPTION.endpoint) {
  return fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-workspace': workspace },
    body: JSON.stringify({ endpoint })
  })
}

test('one device endpoint can be registered in several workspaces independently', async () => {
  await withBrowserNotificationsApp(AUTH, async ({ baseUrl }) => {
    assert.equal((await subscribe(baseUrl, 'workspace-a')).status, 201)
    assert.equal((await subscribe(baseUrl, 'workspace-b')).status, 201)

    // Registering workspace-b must not remove workspace-a's registration.
    assert.deepEqual(await (await lookup(baseUrl, 'workspace-a')).json(), { registered: true })
    assert.deepEqual(await (await lookup(baseUrl, 'workspace-b')).json(), { registered: true })

    // Disabling in workspace-a only unregisters that scope.
    const remove = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-test-workspace': 'workspace-a' },
      body: JSON.stringify({ endpoint: SUBSCRIPTION.endpoint })
    })
    assert.equal(remove.status, 200)
    assert.deepEqual(await (await lookup(baseUrl, 'workspace-a')).json(), { registered: false })
    assert.deepEqual(await (await lookup(baseUrl, 'workspace-b')).json(), { registered: true })
  })
})

test('subscription lookup reports per-scope registration state', async () => {
  await withBrowserNotificationsApp(AUTH, async ({ baseUrl }) => {
    assert.deepEqual(await (await lookup(baseUrl, 'workspace-a')).json(), { registered: false })

    assert.equal((await subscribe(baseUrl, 'workspace-a')).status, 201)
    assert.deepEqual(await (await lookup(baseUrl, 'workspace-a')).json(), { registered: true })
    assert.deepEqual(
      await (await lookup(baseUrl, 'workspace-a', 'https://push.example.test/other-device')).json(),
      { registered: false }
    )
  })
})

test('subscription lookup validates its payload', async () => {
  await withBrowserNotificationsApp(AUTH, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'not-a-url' })
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Invalid lookup payload' })
  })
})
