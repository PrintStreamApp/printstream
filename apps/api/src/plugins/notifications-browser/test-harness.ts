/**
 * Test-only Express harness for the notifications-browser plugin routes.
 * Registers the real plugin against in-memory settings and a stubbed Prisma
 * membership surface. Requests may pick their workspace scope per call via
 * the `x-test-workspace` header (`platform` selects the workspaceless scope);
 * without it every request runs in the default `test-workspace` workspace.
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
  run: (context: { baseUrl: string }) => Promise<void>,
  options: BrowserNotificationsAppOptions = {}
): Promise<void> {
  const memberIds = new Set(
    options.workspaceMembers ?? (auth.actor.type === 'user' ? [auth.actor.userId] : [])
  )
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
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
    await run({ baseUrl })
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
