/**
 * Health endpoints.
 *
 * - `GET /api/health` — liveness: the process is up and serving. Unconditional.
 * - `GET /api/health/ready` — readiness: the API can actually serve requests
 *   (a time-bounded `SELECT 1` against Postgres). Returns 503 when not ready so
 *   orchestrators/load balancers don't route traffic to a DB-less instance.
 */
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { env } from '../lib/env.js'
import { rootPrisma } from '../lib/prisma.js'

export const healthRouter = Router()

const processStartedAt = new Date().toISOString()
const processBootId = randomUUID().slice(0, 8)
/** Cap the readiness DB ping so a hung Postgres can't hang the probe. */
const READINESS_DB_TIMEOUT_MS = 2_000

healthRouter.get('/', (_request, response) => {
  response.json({
    ok: true,
    time: new Date().toISOString(),
    ...(env.NODE_ENV !== 'production'
      ? {
          runtime: {
            nodeEnv: env.NODE_ENV,
            bootId: processBootId,
            startedAt: processStartedAt,
            uptimeSeconds: Math.floor(process.uptime())
          }
        }
      : {})
  })
})

healthRouter.get('/ready', async (_request, response) => {
  try {
    await Promise.race([
      rootPrisma.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('database readiness check timed out')), READINESS_DB_TIMEOUT_MS).unref()
      })
    ])
    response.json({ ok: true, time: new Date().toISOString() })
  } catch (error) {
    response.status(503).json({ ok: false, error: (error as Error).message })
  }
})
