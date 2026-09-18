import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NotificationMessage } from '@printstream/shared'
import { DesktopNotificationFeed } from './feed.js'

function message(id: string, options: Partial<NotificationMessage> = {}): NotificationMessage {
  return { id, category: 'system', level: 'info', title: 'Test', body: 'Body', timestamp: new Date().toISOString(), ...options }
}

test('desktop feed isolates workspace broadcasts and personal recipients', () => {
  const feed = new DesktopNotificationFeed()
  const cursor = feed.read('a', 'alice').cursor
  feed.add(message('a', { workspaceId: 'a' }))
  feed.add(message('b', { workspaceId: 'b' }))
  feed.add(message('operator'))
  feed.add(message('personal', { targetUserIds: ['alice'] }))
  feed.add(message('private', { workspaceId: 'a', targetUserIds: ['bob'] }))

  assert.deepEqual(feed.read('a', 'alice', cursor).events.map((event) => event.id), ['a', 'personal'])
  assert.deepEqual(feed.read('b', 'bob', cursor).events.map((event) => event.id), ['b'])
  assert.deepEqual(feed.read(null, 'alice', cursor).events.map((event) => event.id), ['operator', 'personal'])
})

test('desktop feed starts fresh, replays reconnects and hides recipient metadata', () => {
  const feed = new DesktopNotificationFeed()
  feed.add(message('old', { workspaceId: 'a' }))
  const initial = feed.read('a', 'alice')
  assert.deepEqual(initial.events, [])
  feed.add(message('new', { workspaceId: 'a', targetUserIds: ['alice'], tag: 'thread' }))
  feed.dismiss({ workspaceId: 'a', targetUserIds: ['alice'], tag: 'thread' })
  const replay = feed.read('a', 'alice', initial.cursor)
  assert.deepEqual(replay.events.map((event) => event.type), ['notification', 'dismiss'])
  assert.equal('targetUserIds' in replay.events[0]!, false)
  assert.deepEqual(feed.read('a', 'alice', replay.cursor).events, [])
  assert.equal(feed.read('a', 'bob', initial.cursor).events.length, 0)
})

test('desktop buffer expires on reads, caps count, and recovers after restart', () => {
  let now = 1000
  const feed = new DesktopNotificationFeed(() => now)
  const cursor = feed.read('a', 'alice').cursor
  for (let index = 0; index < 2100; index++) feed.add(message(String(index), { workspaceId: 'a' }))
  assert.equal(feed.read('a', 'alice', cursor).events.length, 2048)
  now += 60 * 60_000
  assert.equal(feed.read('a', 'alice', cursor).events.length, 0)

  const restarted = new DesktopNotificationFeed(() => now)
  restarted.add(message('restart', { workspaceId: 'a' }))
  assert.deepEqual(restarted.read('a', 'alice', cursor).events.map((event) => event.id), ['restart'])
})

test('anonymous workspace devices never receive personal or platform broadcasts', () => {
  const feed = new DesktopNotificationFeed()
  const account = 'anonymous:workshop'
  const cursor = feed.read('workshop', account).cursor
  feed.add(message('print', { workspaceId: 'workshop' }))
  feed.add(message('other', { workspaceId: 'elsewhere' }))
  feed.add(message('private', { workspaceId: 'workshop', targetUserIds: ['alice'] }))
  feed.add(message('platform'))
  assert.deepEqual(feed.read('workshop', account, cursor).events.map(event => event.id), ['print'])
})
