import assert from 'node:assert/strict'
import test from 'node:test'
import type { NotificationMessage } from '@printstream/shared'
import { buildMobilePushData, isUnregisteredFcmResponse } from './fcm.js'

const message: NotificationMessage = {
  id: 'message', category: 'system', level: 'info', title: 'Print finished', body: 'Ready',
  timestamp: new Date().toISOString(), url: '/workspaces/team/printers'
}

test('native payload keeps only same-origin links and optional snapshot routes', () => {
  const data = buildMobilePushData({ ...message, imageUrl: 'https://printstream.app/api/notifications/snapshots/image.jpg' }, 'https://printstream.app', 'binding', 'workspace-1')
  assert.equal(data.url, '/workspaces/team/printers')
  assert.equal(data.image, '/api/notifications/snapshots/image.jpg')
  const external = buildMobilePushData({ ...message, url: '//evil.example/path', imageUrl: 'https://evil.example/image' }, 'https://printstream.app', 'binding', 'workspace-1')
  assert.equal(external.url, '/')
  assert.equal(external.image, '/')
})

test('native payload budgets UTF-8 bytes, not just character count', () => {
  const data = buildMobilePushData({ ...message, title: '😀'.repeat(160), body: '😀'.repeat(1000), tag: '😀'.repeat(180) }, 'https://printstream.app', 'binding', 'workspace-1')
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 3000)
  assert.equal(typeof data.body, 'string')
  assert.throws(() => buildMobilePushData({ ...message, url: '/' + 'a'.repeat(4000) }, 'https://printstream.app', 'binding', 'workspace-1'), /budget/)
})

test('only explicit UNREGISTERED responses retire subscriptions', () => {
  assert.equal(isUnregisteredFcmResponse({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }), true)
  for (const error of [null, {}, { error: { code: 404 } }, { error: { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } }]) {
    assert.equal(isUnregisteredFcmResponse(error), false)
  }
})
