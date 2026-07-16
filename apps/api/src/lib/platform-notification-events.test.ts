process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prisma } from './prisma.js'
import { printerEvents } from './printer-events.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import {
  emitPlatformNotification,
  emitUserNotification,
  getPlatformNotificationTemplate,
  listPlatformNotificationTemplates,
  registerPlatformNotificationEvents,
  renderPlatformNotificationTemplate,
  resetPlatformNotificationTemplate,
  updatePlatformNotificationTemplate
} from './platform-notification-events.js'

const stub = usePrismaStubs()

registerPlatformNotificationEvents([
  {
    event: 'test-event',
    label: 'Test event',
    variables: ['name'],
    defaults: { enabled: true, title: 'Hello {{name}}', body: 'Body for {{name}}' }
  }
])

function stubEmptyStorage() {
  const rows = new Map<string, string>()
  stub(prisma.setting, 'findUnique', async (args: { where: { key: string } }) => {
    const value = rows.get(args.where.key)
    return value == null ? null : { key: args.where.key, value }
  })
  stub(prisma.setting, 'upsert', async (args: { where: { key: string }; create: { key: string; value: string } }) => {
    rows.set(args.where.key, args.create.value)
    return args.create
  })
  stub(prisma.setting, 'deleteMany', async (args: { where: { key: string } }) => {
    rows.delete(args.where.key)
    return { count: 1 }
  })
  return rows
}

test('renderPlatformNotificationTemplate substitutes variables and blanks unknowns', () => {
  assert.equal(
    renderPlatformNotificationTemplate('New signup: {{name}} {{missing}}', { name: 'Nico' }),
    'New signup: Nico '
  )
})

test('templates fall back to defaults, persist updates, and reset', async () => {
  stubEmptyStorage()

  const initial = await getPlatformNotificationTemplate('test-event')
  assert.equal(initial.customized, false)
  assert.equal(initial.title, 'Hello {{name}}')

  const updated = await updatePlatformNotificationTemplate('test-event', { title: 'Hi {{name}}' })
  assert.equal(updated.title, 'Hi {{name}}')
  assert.equal(updated.body, initial.body, 'unspecified fields keep their current value')
  assert.equal(updated.customized, true)
  assert.equal(updated.defaults.title, 'Hello {{name}}')

  const reset = await resetPlatformNotificationTemplate('test-event')
  assert.equal(reset.customized, false)
  assert.equal(reset.title, 'Hello {{name}}')

  const all = await listPlatformNotificationTemplates()
  assert.ok(all.some((template) => template.event === 'test-event'))
})

test('emitPlatformNotification renders and fans out over the bus', async () => {
  stubEmptyStorage()
  const received: Array<{ title: string; body: string; tenantId?: string }> = []
  const listener = (event: { message: { title: string; body: string; tenantId?: string } }) => {
    received.push(event.message)
  }
  printerEvents.on('platform.notification', listener)
  try {
    await emitPlatformNotification('test-event', { name: 'Nico' })
  } finally {
    printerEvents.off('platform.notification', listener)
  }

  assert.equal(received.length, 1)
  assert.equal(received[0]?.title, 'Hello Nico')
  assert.equal(received[0]?.body, 'Body for Nico')
  assert.equal(received[0]?.tenantId, undefined, 'platform messages carry no tenant')
})

test('emitPlatformNotification forwards targeting and email-suppression options', async () => {
  stubEmptyStorage()
  const received: Array<{ targetUserIds?: string[]; emailHandledExternally?: boolean; url?: string; level: string; tag?: string }> = []
  const listener = (event: { message: (typeof received)[number] }) => {
    received.push(event.message)
  }
  printerEvents.on('platform.notification', listener)
  try {
    await emitPlatformNotification('test-event', { name: 'Nico' }, {
      targetUserIds: ['user-1'],
      emailHandledExternally: true,
      url: '/platform/messages?conversation=c1',
      level: 'warning'
    })
    await emitPlatformNotification('test-event', { name: 'Nico' }, { tag: 'support:c1' })
  } finally {
    printerEvents.off('platform.notification', listener)
  }

  assert.equal(received.length, 2)
  assert.deepEqual(received[0]?.targetUserIds, ['user-1'])
  assert.equal(received[0]?.emailHandledExternally, true)
  assert.equal(received[0]?.url, '/platform/messages?conversation=c1')
  assert.equal(received[0]?.level, 'warning')
  assert.equal(received[0]?.tag, 'platform:test-event', 'the event id is the default collapse tag')
  assert.equal(received[1]?.tag, 'support:c1', 'a per-subject tag override wins')
})

test('emitUserNotification stamps id/timestamp and requires targets', () => {
  const received: Array<{ id: string; timestamp: string; targetUserIds?: string[]; title: string }> = []
  const listener = (event: { message: (typeof received)[number] }) => {
    received.push(event.message)
  }
  printerEvents.on('platform.notification', listener)
  try {
    emitUserNotification({
      category: 'system',
      level: 'info',
      title: 'Reply',
      body: 'Body',
      targetUserIds: []
    })
    emitUserNotification({
      category: 'system',
      level: 'info',
      title: 'Reply',
      body: 'Body',
      targetUserIds: ['user-1']
    })
  } finally {
    printerEvents.off('platform.notification', listener)
  }

  assert.equal(received.length, 1, 'empty target lists are dropped')
  assert.deepEqual(received[0]?.targetUserIds, ['user-1'])
  assert.ok(received[0]?.id.length)
  assert.ok(received[0]?.timestamp.length)
})

test('emitPlatformNotification drops disabled and unregistered events', async () => {
  stubEmptyStorage()
  await updatePlatformNotificationTemplate('test-event', { enabled: false })

  let receivedCount = 0
  const listener = () => {
    receivedCount += 1
  }
  printerEvents.on('platform.notification', listener)
  try {
    await emitPlatformNotification('test-event', { name: 'Nico' })
    await emitPlatformNotification('never-registered', {})
  } finally {
    printerEvents.off('platform.notification', listener)
  }

  assert.equal(receivedCount, 0)
})
