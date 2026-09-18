/** Exercise the actual route's authorization, including browser-cookie identity changes during enrollment. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Request, Response } from 'express'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { env } from '../../lib/env.js'
import { notificationsDesktopPlugin } from './index.js'

type Handler = (request: Request, response: Response) => Promise<void>

/** Register the real plugin with a narrowly stubbed membership store, without opening a test socket. */
async function routeHarness() {
  let readHandler: Handler | undefined
  let dismissHandler: Handler | undefined
  let member = true
  let platformUser = false
  const membershipQueries: unknown[] = []
  const printerEvents = new PrinterEventBus()
  const dismissals: unknown[] = []
  printerEvents.on('notification.dismiss', (event) => dismissals.push(event))
  await notificationsDesktopPlugin.register({
    router: {
      get(_path: string, route: Handler) { readHandler = route },
      post(_path: string, route: Handler) { dismissHandler = route }
    },
    printerEvents,
    logger: { warn() {} },
    onShutdown() {},
    prisma: {
      authWorkspaceMembership: {
        async findFirst(query: unknown) {
          membershipQueries.push(query)
          return member ? { userId: 'alice' } : null
        }
      },
      authUser: { async findFirst() { return platformUser ? { id: 'alice' } : null } },
      workspace: { async findFirst() { return { id: 'workshop', slug: 'workshop', name: 'Workshop' } } },
      setting: { async findUnique() { return null } }
    }
  } as never)
  assert.ok(readHandler)
  assert.ok(dismissHandler)

  return {
    membershipQueries,
    dismissals,
    revoke() { member = false },
    allowPlatform() { platformUser = true },
    async read(options: { actor?: string; enrolled?: string; platform?: boolean; cursor?: unknown; authEnabled?: boolean } = {}) {
      let result: unknown
      let cacheControl: unknown
      await readHandler!({
        auth: { authEnabled: options.authEnabled ?? true, runtimePolicy: { demoMode: false }, actor: options.actor === 'anonymous' ? { type: 'anonymous' } : { type: 'user', userId: options.actor ?? 'alice' } },
        workspace: options.platform ? null : { id: 'workshop' },
        query: options.cursor === undefined ? {} : { cursor: options.cursor },
        get: () => options.enrolled ?? 'alice'
      } as unknown as Request, {
        setHeader(_name: string, value: unknown) { cacheControl = value },
        json(value: unknown) { result = value }
      } as Response)
      assert.equal(cacheControl, 'no-store')
      return result
    },
    async dismiss(options: { actor?: string; enrolled?: string; authEnabled?: boolean } = {}) {
      let status = 200
      let result: unknown
      await dismissHandler!({
        auth: {
          authEnabled: options.authEnabled ?? true,
          runtimePolicy: { demoMode: false },
          actor: options.actor === 'anonymous'
            ? { type: 'anonymous' }
            : { type: 'user', userId: options.actor ?? 'alice' }
        },
        workspace: { id: 'workshop' },
        body: { tag: 'printer:p1:job', notificationId: 'message-1' },
        get: () => options.enrolled ?? 'alice'
      } as unknown as Request, {
        status(value: number) { status = value; return this },
        json(value: unknown) { result = value }
      } as Response)
      return { status, result }
    }
  }
}

test('desktop feed requires the enrolled actor and fresh membership without admin permissions', async () => {
  const app = await routeHarness()
  await assert.rejects(app.read({ actor: 'anonymous' }), { statusCode: 401 })
  await assert.rejects(app.read({ actor: 'bob' }), { statusCode: 401 })
  assert.equal(app.membershipQueries.length, 0)

  assert.deepEqual((await app.read() as { events: unknown[] }).events, [])
  assert.deepEqual(app.membershipQueries[0], {
    where: { userId: 'alice', workspaceId: 'workshop', loginDisabled: false }, select: { userId: true }
  })
  app.revoke()
  await assert.rejects(app.read(), { statusCode: 403 })
})

test('platform delivery requires platform membership and malformed cursors are rejected', async () => {
  const app = await routeHarness()
  await assert.rejects(app.read({ platform: true }), { statusCode: 403 })
  app.allowPlatform()
  await app.read({ platform: true })
  await assert.rejects(app.read({ cursor: ['unexpected', 'array'] }), { statusCode: 400 })
  await assert.rejects(app.read({ cursor: 'x'.repeat(101) }), { statusCode: 400 })
})

test('self-hosted anonymous reads require disabled authentication and the matching consent identity', async () => {
  const previous = env.SELF_HOSTED
  env.SELF_HOSTED = true
  try {
    const app = await routeHarness()
    await app.read({ actor: 'anonymous', authEnabled: false, enrolled: 'anonymous:workshop' })
    await assert.rejects(app.read({ actor: 'anonymous', authEnabled: false, enrolled: 'anonymous:other' }), { statusCode: 401 })
    await assert.rejects(app.read({ actor: 'anonymous', authEnabled: true, enrolled: 'anonymous:workshop' }), { statusCode: 401 })
    await assert.rejects(app.read({ actor: 'anonymous', authEnabled: false, platform: true, enrolled: 'anonymous:workshop' }), { statusCode: 401 })
    assert.equal(app.membershipQueries.length, 0)
  } finally {
    env.SELF_HOSTED = previous
  }
})

test('desktop dismissals synchronize only for an identified eligible user', async () => {
  const app = await routeHarness()
  assert.deepEqual(await app.dismiss(), { status: 202, result: { ok: true } })
  assert.deepEqual(app.dismissals, [{
    tag: 'printer:p1:job',
    notificationId: 'message-1',
    workspaceId: null,
    targetUserIds: ['alice']
  }])

  const previous = env.SELF_HOSTED
  env.SELF_HOSTED = true
  try {
    assert.deepEqual(await app.dismiss({ actor: 'anonymous', authEnabled: false, enrolled: 'anonymous:workshop' }), {
      status: 202,
      result: { ok: true }
    })
    assert.equal(app.dismissals.length, 1)
  } finally {
    env.SELF_HOSTED = previous
  }
})
