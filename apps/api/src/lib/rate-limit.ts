/**
 * Lightweight in-process HTTP rate limiting for API routes.
 *
 * This is intentionally local to the Node process; deployments with many API
 * replicas should front it with a shared proxy or external limiter. Keys prefer
 * authenticated actor identity and fall back to client IP for anonymous traffic.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'

type RateLimitMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface RateLimitOptions {
  name: string
  windowMs: number
  max: number
  methods?: readonly RateLimitMethod[]
  skip?: (request: Request) => boolean
  now?: () => number
}

interface RateLimitEntry {
  count: number
  resetAt: number
}

export function createRateLimitMiddleware(options: RateLimitOptions): RequestHandler {
  const entries = new Map<string, RateLimitEntry>()
  const methods = options.methods ? new Set<string>(options.methods) : null
  const now = options.now ?? Date.now
  let nextCleanupAt = now() + options.windowMs

  return (request: Request, response: Response, next: NextFunction) => {
    if (methods && !methods.has(request.method)) {
      next()
      return
    }
    if (options.skip?.(request)) {
      next()
      return
    }

    const currentTime = now()
    if (currentTime >= nextCleanupAt) {
      cleanupExpiredEntries(entries, currentTime)
      nextCleanupAt = currentTime + options.windowMs
    }

    const key = `${options.name}:${readRateLimitSubject(request)}`
    const existing = entries.get(key)
    const entry = existing && existing.resetAt > currentTime
      ? existing
      : { count: 0, resetAt: currentTime + options.windowMs }
    entry.count += 1
    entries.set(key, entry)

    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000))
    applyRateLimitHeaders(response, {
      limit: options.max,
      remaining: Math.max(0, options.max - entry.count),
      resetSeconds
    })

    if (entry.count <= options.max) {
      next()
      return
    }

    response.setHeader('Retry-After', String(resetSeconds))
    response.setHeader('Cache-Control', 'no-store')
    response.status(429).json({ error: 'Too many requests. Try again later.' })
  }
}

/**
 * Advertise the budget on every response (IETF draft `RateLimit-*` headers) so
 * clients with bursty workloads — e.g. chunked library uploads — can pace
 * themselves against the real budget instead of guessing. Stacked limiters
 * each call this; the headers keep the most-restrictive snapshot (lowest
 * remaining) seen for the request.
 */
function applyRateLimitHeaders(
  response: Response,
  info: { limit: number; remaining: number; resetSeconds: number }
): void {
  const existing = response.getHeader('RateLimit-Remaining')
  if (existing !== undefined && Number(existing) <= info.remaining) return
  response.setHeader('RateLimit-Limit', String(info.limit))
  response.setHeader('RateLimit-Remaining', String(info.remaining))
  response.setHeader('RateLimit-Reset', String(info.resetSeconds))
}

function cleanupExpiredEntries(entries: Map<string, RateLimitEntry>, currentTime: number): void {
  for (const [key, entry] of entries.entries()) {
    if (entry.resetAt <= currentTime) {
      entries.delete(key)
    }
  }
}

function readRateLimitSubject(request: Request): string {
  const actor = request.auth?.actor
  if (actor?.type === 'user') {
    return `user:${actor.userId}`
  }
  if (actor?.type === 'service-account') {
    return `service-account:${actor.serviceAccountId}`
  }

  return `ip:${request.ip || request.socket.remoteAddress || 'unknown'}`
}