/** Exercise the binding-authenticated dismissal route without opening a server socket. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Request, Response } from 'express'
import type { ApiPluginContext } from '../../plugin/types.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { notificationsMobilePlugin } from './index.js'
import { MobileSubscriptions, type MobileDevice } from './subscriptions.js'

type Handler = (request: Request, response: Response) => Promise<void>

const phoneBinding = '6caa2337-01f6-4be2-a7d3-a628c5dc9b57'

/** Register the real route against the same scoped settings shape used in production. */
async function routeHarness() {
  const values = new Map<string | null, string>()
  const routes = new Map<string, Handler>()
  const printerEvents = new PrinterEventBus()
  const dismissals: unknown[] = []
  const store = (scope: string | null): unknown => ({
    get: async () => values.get(scope),
    set: async (_key: string, value: string) => { values.set(scope, value) },
    forWorkspace: (workspace: string) => store(workspace)
  })
  const context = {
    pluginName: 'notifications-mobile',
    settings: store(null),
    router: {
      post(path: string, handler: Handler) { routes.set(path, handler) },
      get() {},
      delete() {},
      use() {}
    },
    printerEvents,
    logger: { warn() {} },
    onShutdown() {},
    isEnabledForWorkspace: () => true,
    prisma: {
      authWorkspaceMembership: {
        async findFirst(args: { where: { userId: string } }) {
          return args.where.userId === 'alice' ? { userId: 'alice' } : null
        }
      },
      authUser: { async findFirst() { return null } },
      setting: { async findMany() { return [] } }
    }
  } as unknown as ApiPluginContext
  printerEvents.on('notification.dismiss', (event) => dismissals.push(event))
  await notificationsMobilePlugin.register(context)
  const handler = routes.get('/dismissals')
  assert.ok(handler)

  const subscriptions = new MobileSubscriptions(context)
  const device = (userId: string): MobileDevice => ({
    userId,
    token: `${userId}-token`,
    bindingId: phoneBinding,
    origin: 'https://printstream.app',
    updatedAt: Date.now()
  })

  return {
    dismissals,
    subscriptions,
    device,
    async dismiss(scope: string | null = 'workshop') {
      let status = 200
      let result: unknown
      await handler({
        body: {
          bindingId: phoneBinding,
          scope,
          tag: 'printer:p1:job',
          notificationId: 'message-1'
        }
      } as Request, {
        status(value: number) { status = value; return this },
        json(value: unknown) { result = value }
      } as Response)
      return { status, result }
    }
  }
}

test('mobile dismissals synchronize an enrolled user and exclude the reporting device', async () => {
  const app = await routeHarness()
  await app.subscriptions.update('workshop', () => [app.device('alice')])

  assert.deepEqual(await app.dismiss(), { status: 202, result: { ok: true } })
  assert.deepEqual(app.dismissals, [{
    tag: 'printer:p1:job',
    notificationId: 'message-1',
    workspaceId: null,
    targetUserIds: ['alice'],
    excludeMobileBindingIds: [phoneBinding]
  }])
})

test('anonymous and unknown mobile bindings keep dismissals on the reporting device', async () => {
  const app = await routeHarness()
  await app.subscriptions.update('workshop', () => [app.device('anonymous:workshop')])

  assert.deepEqual(await app.dismiss(), { status: 202, result: { ok: true } })
  assert.equal(app.dismissals.length, 0)
  assert.deepEqual(await app.dismiss(null), { status: 202, result: { ok: true } })
  assert.equal(app.dismissals.length, 0)
})
