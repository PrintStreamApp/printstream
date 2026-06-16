/**
 * Shared request-derived helpers for routes and plugins.
 */
import type { NextFunction, Request, Response } from 'express'
import type { Multer } from 'multer'
import { MulterError } from 'multer'
import { badRequest } from './http-error.js'

export function requireRouteParam(value: string | string[] | undefined, name: string): string {
  const resolved = Array.isArray(value) ? value[0] : value
  if (typeof resolved === 'string' && resolved.length > 0) {
    return resolved
  }
  throw badRequest(`Missing route parameter: ${name}`)
}

export function requireRequestTenantId(request: Request): string {
  if (request.tenant?.id) {
    return request.tenant.id
  }
  throw badRequest('Tenant context is required')
}

export function readRequestLocale(request: Request): string | null {
  const header = request.headers['accept-language']
  const value = Array.isArray(header) ? header[0] : header
  const locale = value?.split(',')[0]?.trim()
  return locale || null
}

/**
 * The origin the request arrived on (`https://host`), honoring `trust proxy`
 * for the protocol. Null when the Host header is missing.
 */
export function readRequestOrigin(request: Request): string | null {
  const host = request.get('host')
  if (!host) return null
  return `${request.protocol}://${host}`
}

export function readRequestTimeZone(request: Request): string | null {
  const header = request.headers['x-printstream-time-zone']
  const value = Array.isArray(header) ? header[0] : header
  const timeZone = value?.trim()
  return timeZone || null
}

/**
 * Builds an `AbortSignal` that fires when the underlying HTTP request/response
 * is closed or aborted. Use it to cancel in-flight downloads/streams when the
 * client disconnects.
 */
export function requestAbortSignal(request: Request, response: Response): AbortSignal {
  const controller = new AbortController()
  const abort = () => controller.abort()
  request.once('aborted', abort)
  request.once('close', abort)
  response.once('close', abort)
  return controller.signal
}

/**
 * Parses a positive integer from a string query parameter. Returns `null` when
 * the value is absent, not a string, or not a finite integer greater than zero.
 */
export function parsePositiveIntQuery(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Resolves a 1-based plate index from a query parameter, coercing with
 * `Number(...)` and flooring fractional values. Falls back to plate `1` when
 * the value is missing or not a positive number.
 */
export function parsePlateIndexQuery(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1
}

export interface SingleUploadOptions {
  /** A pre-configured multer instance (storage + limits set by the caller). */
  upload: Multer
  /** Form field name carrying the single file (e.g. `'file'`). */
  field: string
  /** The byte limit the multer instance was configured with; passed to `onLimitExceeded`. */
  maxBytes: number
  /** Builds the error passed to `next()` when the file exceeds `maxBytes`. */
  onLimitExceeded: (maxBytes: number) => unknown
  /**
   * Maps any other `MulterError` (not `LIMIT_FILE_SIZE`) to the error passed to
   * `next()`. When omitted, such errors fall through to `onOtherError`.
   */
  onMulterError?: (error: MulterError) => unknown
  /**
   * Transforms any non-`MulterError` error (and, when `onMulterError` is
   * omitted, other multer errors) before it is passed to `next()`. Defaults to
   * passing the error through unchanged.
   */
  onOtherError?: (error: unknown) => unknown
}

/**
 * Wraps a multer single-file upload so that a payload-size overflow surfaces as
 * a caller-defined HTTP error (typically a 413) instead of a generic 500. The
 * size limit itself is configured on the supplied multer instance; this helper
 * only owns the error mapping and the middleware wiring. Each call site keeps
 * its own status/message/control-flow via the option callbacks.
 */
export function singleUploadWithLimit(options: SingleUploadOptions) {
  const handler = options.upload.single(options.field)
  const passThrough = (error: unknown) => error
  const onOtherError = options.onOtherError ?? passThrough
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response, (error: unknown) => {
      if (error instanceof MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          next(options.onLimitExceeded(options.maxBytes) as Parameters<NextFunction>[0])
          return
        }
        if (options.onMulterError) {
          next(options.onMulterError(error) as Parameters<NextFunction>[0])
          return
        }
      }
      next(onOtherError(error) as Parameters<NextFunction>[0])
    })
  }
}