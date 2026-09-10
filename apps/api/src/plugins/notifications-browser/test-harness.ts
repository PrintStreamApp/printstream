/**
 * Test-only Express harness for the notifications-browser plugin routes.
 * Registers the real plugin against in-memory settings and a stubbed Prisma
 * membership surface. Requests may pick their workspace scope per call via
 * the `x-test-workspace` header (`platform` selects the workspaceless scope);
 * without it every request runs in the default `test-workspace` workspace.
 * `x-test-actor` likewise swaps the acting user id for one request.
 *
 * The Prisma stub also answers `setting.findMany`, projecting the in-memory
 * settings map into the `plugin:<name>:workspace:<id>:<key>` row shape that
 * `listWorkspaceScopesWithPluginSetting` reads, so cross-scope fan-out (a
 * dismissal reaching the actor's devices in every workspace they registered
 * in) exercises the real enumeration rather than a hand-fed scope list.
 */
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { notificationsBrowserPlugin } from './index.js'

export interface BrowserNotificationsAppOptions {
  workspaceMembers?: string[]
}

export async function withBrowserNotificationsApp(
  auth: RequestAuthContext,
  /**
   * `settings` is the raw in-memory store, so a test can seed state the routes
   * cannot create (a legacy subscription with no actor key, say). Scoped keys
   * are `workspace:<id>:<key>`; the scope's delivery is built lazily on first
   * request, so seed before the request that reads it.
   */
  run: (context: { baseUrl: string; settings: Map<string, string> }) => Promise<void>,
  options: BrowserNotificationsAppOptions = {}
): Promise<void> {
  const memberIds = new Set(
    options.workspaceMembers ?? (auth.actor.type === 'user' ? [auth.actor.userId] : [])
  )
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    // `x-test-actor` swaps the user id for one request, keeping every other
    // field, so a test can act as a second member of the same workspace
    // without standing up a second app.
    const actorOverride = request.headers['x-test-actor']
    request.auth = typeof actorOverride === 'string' && auth.actor.type === 'user'
      ? { ...auth, actor: { ...auth.actor, userId: actorOverride } }
      : auth
    const scope = typeof request.headers['x-test-workspace'] === 'string'
      ? request.headers['x-test-workspace']
      : 'test-workspace'
    request.workspace = scope === 'platform'
      ? null
      : { id: scope, slug: scope, name: `Workspace ${scope}` }
    next()
  })

  const router = express.Router()
  app.use('/api/plugins/notifications-browser', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const settings = new Map<string, string>()
  await notificationsBrowserPlugin.register({
    pluginName: 'notifications-browser',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authWorkspaceMembership: {
        async findFirst({ where }: { where: { userId: string } }) {
          return memberIds.has(where.userId) ? { userId: where.userId } : null
        },
        async findMany({ where }: { where: { userId: { in: string[] } } }) {
          return where.userId.in.filter((userId) => memberIds.has(userId)).map((userId) => ({ userId }))
        }
      },
      setting: {
        async findMany({ where }: { where: { key: { startsWith: string; endsWith: string } } }) {
          // `forWorkspace` below stores under `workspace:<id>:<key>`; real rows
          // carry the plugin prefix the scope enumeration parses.
          return [...settings.keys()]
            .filter((key) => key.startsWith('workspace:'))
            .map((key) => ({ key: `plugin:notifications-browser:${key}` }))
            .filter(({ key }) => key.startsWith(where.key.startsWith) && key.endsWith(where.key.endsWith))
        }
      }
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast() {} } as never,
    router,
    settings: {
      async get(key) { return settings.get(key) ?? null },
      async set(key, value) { settings.set(key, value) },
      async delete(key) { settings.delete(key) },
      forWorkspace(workspaceId: string) {
        const prefix = `workspace:${workspaceId}:`
        return {
          async get(key: string) { return settings.get(prefix + key) ?? null },
          async set(key: string, value: string) { settings.set(prefix + key, value) },
          async delete(key: string) { settings.delete(prefix + key) },
          forWorkspace(): never { throw new Error('nested forWorkspace not supported') }
        }
      }
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerSlotFilamentResolver() { return () => undefined },
    registerBambuAccountResolver() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run({ baseUrl, settings })
  } finally {
    await close(server)
  }
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
