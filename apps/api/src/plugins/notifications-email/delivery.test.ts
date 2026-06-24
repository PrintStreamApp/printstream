import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { NotificationMessage } from '@printstream/shared'
import { emailTransportRegistry, type EmailInput } from '../../lib/email-delivery.js'
import type { ApiPluginContext, PluginSettingStore } from '../../plugin/types.js'
import { createEmailNotificationHandler } from './delivery.js'

afterEach(() => {
  emailTransportRegistry.clear()
})

function tenantStore(subscribers: string[]): PluginSettingStore {
  const store: PluginSettingStore = {
    async get(key) { return key === 'subscribers' ? JSON.stringify(subscribers) : null },
    async set() {},
    async delete() {},
    forTenant: () => store
  }
  return store
}

function buildContext(input: {
  subscribers: string[]
  members: Array<{ email: string }>
}): ApiPluginContext {
  const settings: PluginSettingStore = {
    async get() { return null },
    async set() {},
    async delete() {},
    forTenant: () => tenantStore(input.subscribers)
  }
  return {
    settings,
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authTenantMembership: {
        async findMany() {
          return input.members.map((member) => ({ user: { email: member.email } }))
        }
      }
    }
  } as unknown as ApiPluginContext
}

function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    tenantId: 'tenant-1',
    title: 'Print finished',
    body: 'Benchy finished on Printer A',
    url: '/printers/p1',
    ...overrides
  } as NotificationMessage
}

function captureTransport(sink: EmailInput[], configured = true) {
  emailTransportRegistry.clear()
  emailTransportRegistry.register({
    name: 'test',
    isConfigured: () => configured,
    send: async (input) => { sink.push(input) }
  })
}

test('emails each opted-in, current member once', async () => {
  const sink: EmailInput[] = []
  captureTransport(sink)
  const handler = createEmailNotificationHandler(buildContext({
    subscribers: ['u1', 'u2', 'u3'],
    members: [{ email: 'a@example.com' }, { email: 'b@example.com' }] // u3 filtered out by the membership query
  }))

  await handler(message())

  assert.deepEqual(sink.map((m) => m.to).sort(), ['a@example.com', 'b@example.com'])
  assert.equal(sink[0]?.subject, 'Print finished')
})

test('no-op when email delivery is not configured', async () => {
  const sink: EmailInput[] = []
  captureTransport(sink, false)
  const handler = createEmailNotificationHandler(buildContext({ subscribers: ['u1'], members: [{ email: 'a@example.com' }] }))
  await handler(message())
  assert.equal(sink.length, 0)
})

test('no-op when there are no subscribers', async () => {
  const sink: EmailInput[] = []
  captureTransport(sink)
  const handler = createEmailNotificationHandler(buildContext({ subscribers: [], members: [] }))
  await handler(message())
  assert.equal(sink.length, 0)
})

test('skips events without a tenant', async () => {
  const sink: EmailInput[] = []
  captureTransport(sink)
  const handler = createEmailNotificationHandler(buildContext({ subscribers: ['u1'], members: [{ email: 'a@example.com' }] }))
  await handler(message({ tenantId: undefined }))
  assert.equal(sink.length, 0)
})
