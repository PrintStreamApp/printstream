/**
 * Liveness endpoint.
 */
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { env } from '../lib/env.js'

export const healthRouter = Router()

const processStartedAt = new Date().toISOString()
const processBootId = randomUUID().slice(0, 8)

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
