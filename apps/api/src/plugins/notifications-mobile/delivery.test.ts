import assert from 'node:assert/strict'
import test from 'node:test'
import type { NotificationMessage } from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { mobileNotificationHandler } from './delivery.js'
import { MobileSubscriptions, type MobileDevice } from './subscriptions.js'

const bindingId = '6caa2337-01f6-4be2-a7d3-a628c5dc9b57'
const message: NotificationMessage = {
  id: 'message', category: 'system', level: 'info', title: 'Print finished', body: 'Ready',
  timestamp: new Date().toISOString(), workspaceId: 'alpha'
}

/** A scope-backed fake exercises the real serialized subscription store and recipient checks. */
function fixture() {
  const values = new Map<string | null, string>()
  const membershipChecks: unknown[] = []
  const store = (scope: string | null): unknown => ({
    get: async () => values.get(scope),
    set: async (_key: string, value: string) => { values.set(scope, value) },
    forWorkspace: (workspace: string) => store(workspace)
  })
  const context = {
    pluginName: 'notifications-mobile', settings: store(null), logger: { warn: () => {} },
    isEnabledForWorkspace: (scope: string | null) => scope !== 'disabled',
    prisma: {
      authWorkspaceMembership: { findFirst: async (args: { where: { userId: string } }) => {
        membershipChecks.push(args)
        return args.where.userId === 'removed' ? null : { userId: args.where.userId }
      } },
      authUser: { findFirst: async () => null },
      setting: { findMany: async () => [...values.keys()].filter(Boolean).map((scope) => ({ key: `plugin:notifications-mobile:workspace:${scope}:devices` })) }
    }
  } as unknown as ApiPluginContext
  const subscriptions = new MobileSubscriptions(context)
  const device = (userId: string, token = userId): MobileDevice => ({ userId, token, bindingId, origin: 'https://printstream.app', updatedAt: Date.now() })
  const sent: string[] = []
  const deliver = mobileNotificationHandler(context, subscriptions, {
    configured: () => true, send: async (token) => { sent.push(token); return token !== 'expired' }
  })
  return { subscriptions, device, sent, deliver, membershipChecks, context }
}

test('broadcast stays scoped and checks enabled membership at delivery time', async () => {
  const f = fixture()
  await f.subscriptions.update('alpha', () => [f.device('alice'), f.device('removed')])
  await f.subscriptions.update('beta', () => [f.device('bob')])
  assert.equal(await f.deliver(message), 1)
  assert.deepEqual(f.sent, ['alice'])
  assert.deepEqual(f.membershipChecks[0], { where: { userId: 'alice', workspaceId: 'alpha', loginDisabled: false }, select: { userId: true } })
})

test('personal cross-scope messages deduplicate devices and exclude other actors and disabled scopes', async () => {
  const f = fixture()
  await f.subscriptions.update('alpha', () => [f.device('alice'), f.device('bob')])
  await f.subscriptions.update('beta', () => [f.device('alice')])
  await f.subscriptions.update('disabled', () => [f.device('alice', 'disabled-device')])
  assert.equal(await f.deliver({ ...message, workspaceId: undefined, targetUserIds: ['alice'] }), 1)
  assert.deepEqual(f.sent, ['alice'])
})

test('expired devices are removed but transport failures preserve enrolment', async () => {
  const f = fixture()
  await f.subscriptions.update('alpha', () => [f.device('alice', 'expired')])
  assert.equal(await f.deliver(message), 0)
  assert.deepEqual(await f.subscriptions.read('alpha'), [])
  await f.subscriptions.update('alpha', () => [f.device('alice')])
  const failure = mobileNotificationHandler(f.context, f.subscriptions, { configured: () => true, send: async () => { throw new Error('403') } })
  assert.equal(await failure(message), 0)
  assert.equal((await f.subscriptions.read('alpha')).length, 1)
})

test('concurrent enrolments do not lose devices and leases expire', async () => {
  const f = fixture()
  await Promise.all(['a', 'b', 'c'].map((user) => f.subscriptions.update('alpha', (entries) => [...entries, f.device(user)])))
  assert.equal((await f.subscriptions.read('alpha')).length, 3)
  await f.subscriptions.update('alpha', (entries) => [...entries, { ...f.device('old'), updatedAt: 0 }])
  assert.equal((await f.subscriptions.read('alpha')).length, 3)
})
