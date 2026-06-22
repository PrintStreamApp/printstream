/**
 * Request-scoped correlation (request) id.
 *
 * A correlation id is minted once at the edge of an operation and made ambient
 * via `AsyncLocalStorage`, so every log line emitted while handling that
 * operation can be stamped with the same id (see `logs.ts`) and grouped after
 * the fact. The id is also echoed back on the `X-Request-Id` response header
 * and in error bodies so a user-reported failure maps straight to server logs.
 *
 * Kept separate from `tenant-context.ts`: this wraps the request *outermost*
 * (before auth/tenant resolution) so even rate-limit/auth/tenant failures are
 * correlated, and it has no database or auth dependencies.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

interface RequestContext {
  correlationId: string
}

const REQUEST_ID_HEADER = 'x-request-id'
/** Bound the accepted inbound id so a client cannot inject huge/unsafe values. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/

const requestContextStorage = new AsyncLocalStorage<RequestContext>()

/**
 * Express middleware that establishes the per-request correlation id. Honors a
 * sanitized inbound `X-Request-Id` (so an upstream proxy or caller can supply
 * one and have both sides agree), otherwise generates a UUID. Mount this first,
 * before any other middleware.
 */
export function installRequestContext() {
  return (request: Request, response: Response, next: NextFunction): void => {
    const correlationId = readInboundCorrelationId(request) ?? randomUUID()
    response.setHeader('X-Request-Id', correlationId)
    requestContextStorage.run({ correlationId }, () => next())
  }
}

/** The current request's correlation id, or null outside any request context. */
export function getCorrelationId(): string | null {
  return requestContextStorage.getStore()?.correlationId ?? null
}

/**
 * Run `callback` under a correlation id for non-HTTP entry points (bridge
 * messages, scheduled jobs, event callbacks) so their logs are groupable too.
 * Generates an id when one is not supplied.
 */
export function withCorrelationId<T>(correlationId: string | null, callback: () => T): T {
  return requestContextStorage.run({ correlationId: correlationId ?? randomUUID() }, callback)
}

function readInboundCorrelationId(request: Pick<Request, 'headers'>): string | null {
  const raw = request.headers[REQUEST_ID_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return SAFE_CORRELATION_ID.test(trimmed) ? trimmed : null
}
