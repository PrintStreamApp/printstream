/**
 * Express application wiring. Keeps middleware and route mounting in one
 * place; route handlers stay thin and delegate to modules under `src/lib`.
 */
import cors from 'cors'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import { env } from './lib/env.js'
import { installAuthContext } from './lib/auth-context.js'
import { installTenantContext } from './lib/tenant-context.js'
import { HttpError } from './lib/http-error.js'
import { authRouter } from './routes/auth.js'
import { healthRouter } from './routes/health.js'
import { printersRouter } from './routes/printers.js'
import { libraryRouter } from './routes/library.js'
import { jobsRouter } from './routes/jobs.js'
import { cameraRouter } from './routes/camera.js'
import { logsRouter } from './routes/logs.js'
import { adminPluginsRouter } from './routes/admin-plugins.js'
import { pluginCatalogRouter } from './routes/plugin-catalog.js'
import { notificationsRouter } from './routes/notifications.js'
import { printDispatchRouter } from './routes/print-dispatch.js'
import { slicingRouter } from './routes/slicing.js'
import { editorRouter } from './routes/editor.js'
import { deleteOperationsRouter } from './routes/delete-operations.js'
import { printerViewsRouter } from './routes/printer-views.js'
import { settingsRouter } from './routes/settings.js'
import { bridgesRouter } from './routes/bridges.js'
import { bridgeRuntimeRouter } from './routes/bridge-runtime.js'
import { tenantStatsRouter } from './routes/stats.js'
import { pluginRegistry } from './plugin/registry.js'
import { installAuditLogCapture } from './lib/audit-logs.js'
import { installLogCapture } from './lib/logs.js'
import { createRateLimitMiddleware } from './lib/rate-limit.js'
import { registerPrivateModules } from './lib/private-modules.js'

installLogCapture()

export const app = express()

// When running behind a reverse proxy (nginx, Caddy, etc) Express
// needs to know how many hops to trust so `req.ip` / `req.protocol`
// reflect the real client. Configured via `TRUST_PROXY`; off by
// default for direct-to-internet deployments.
if (env.TRUST_PROXY) {
  const value = env.TRUST_PROXY.trim()
  if (value === 'true' || value === 'false') {
    app.set('trust proxy', value === 'true')
  } else if (/^\d+$/.test(value)) {
    app.set('trust proxy', Number.parseInt(value, 10))
  } else {
    // Comma-separated IP/CIDR list — Express accepts a string or array.
    app.set('trust proxy', value.split(',').map((entry) => entry.trim()).filter(Boolean))
  }
}

const allowedOrigins = new Set(
  env.CLIENT_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean)
)

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true)
        return
      }
      callback(null, false)
    },
    credentials: true,
    // Let the browser read rate-budget headers so uploads can self-pace.
    exposedHeaders: ['Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset']
  })
)
// Helmet defaults are conservative; relax CSP because we proxy MJPEG and
// stream binary data that the strict default would block.
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }))
const skipHealthChecks = (request: Request) => request.originalUrl === '/api/health' || request.originalUrl === '/api/health/'
app.use('/api', createRateLimitMiddleware({
  name: 'api-preauth',
  windowMs: 60_000,
  max: 1_800,
  skip: skipHealthChecks
}))
app.use(express.json({ limit: '4mb' }))
app.use(installAuthContext({ demoMode: false }))
app.use(installTenantContext())
app.use(installAuditLogCapture())

app.use('/api/auth', createRateLimitMiddleware({
  name: 'auth',
  windowMs: 60_000,
  max: 120
}))
app.use('/api/plugins/auth-local/email-codes', createRateLimitMiddleware({
  name: 'auth-local-email-codes',
  windowMs: 15 * 60_000,
  max: 20
}))
app.use('/api', createRateLimitMiddleware({
  name: 'api-read',
  windowMs: 60_000,
  max: 900,
  methods: ['GET', 'HEAD'],
  skip: skipHealthChecks
}))
app.use('/api', createRateLimitMiddleware({
  name: 'api-write',
  windowMs: 60_000,
  max: 120,
  methods: ['POST', 'PATCH', 'PUT', 'DELETE'],
  skip: skipHealthChecks
}))

app.use('/api/auth', authRouter)
app.use('/api/health', healthRouter)
app.use('/api/printers', printersRouter)
app.use('/api/printer-views', printerViewsRouter)
app.use('/api/library', libraryRouter)
app.use('/api/jobs', jobsRouter)
app.use('/api/print-dispatch', printDispatchRouter)
app.use('/api/slicing', slicingRouter)
app.use('/api/editor', editorRouter)
app.use('/api/delete-operations', deleteOperationsRouter)
app.use('/api/camera', cameraRouter)
app.use('/api/logs', logsRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/bridges', bridgesRouter)
app.use('/api/bridge-runtime', bridgeRuntimeRouter)
app.use('/api/stats', tenantStatsRouter)
app.use('/api/admin/plugins', adminPluginsRouter)
app.use('/api/plugin-catalog', pluginCatalogRouter)
app.use('/api/plugins', pluginRegistry.router)

// First-party private modules (closed-source cloud surface) mount their own
// routes here. The directory is absent in public builds; this is a no-op then.
await registerPrivateModules(app)

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    response.status(error.statusCode).json({ error: error.message })
    return
  }
  console.error(error)
  response.status(500).json({ error: 'Internal server error' })
})
