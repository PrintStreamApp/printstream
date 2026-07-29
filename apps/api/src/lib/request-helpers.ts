/**
 * Shared request-derived helpers for routes and plugins.
 */
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { NextFunction, Request, Response } from 'express'
import type { Multer } from 'multer'
import { MulterError } from 'multer'
import { badRequest } from './http-error.js'

const gzipAsync = promisify(gzip)

/** Bytes per write when handing the body to the socket. See {@link sendModelBuffer}. */
const MODEL_BODY_CHUNK_BYTES = 64 * 1024

/**
 * Send a model/mesh buffer, gzip-compressing it when the client advertises gzip support.
 *
 * Library model entries are multi-megabyte XML, import/preview meshes are large binary STL, and
 * `/archive` serves a whole 3MF. Two properties matter, and the body is compressed up front rather
 * than through a `createGzip()` stream so it can have both:
 *
 * - **Written in many small chunks.** A large single-buffer `res.send()` is truncated mid-stream by
 *   the Vite dev proxy (and other size-limited proxies) — the browser receives most of the body,
 *   waits for a tail that never arrives, and the editor's geometry load hangs. Small chunks pass
 *   through cleanly.
 * - **Sent with a `Content-Length`.** This is what makes a short body FAIL rather than corrupt. A
 *   streamed gzip has no declared length, so a body that ends early is indistinguishable from one
 *   that ended: the browser accepts it, may cache it, and the caller gets a truncated buffer with
 *   no error. Downstream that surfaces as "this file could not be opened as a 3MF archive", which
 *   points at the file rather than at the transport. With a length declared, the browser rejects
 *   the response and `fetchModelBytes` throws — and it will not store a partial response either,
 *   which matters because these routes are conditional (see `ARCHIVE_ETAG_VARIANT` in
 *   `routes/library.ts`, where a cached broken body once outlived the bug that produced it).
 *
 * Peak memory is therefore the raw buffer plus its compressed copy; the caller has already
 * materialized the former, so this adds the latter. Tiny payloads skip compression (the gzip
 * framing isn't worth it), and clients that don't advertise gzip receive the raw bytes.
 */
export async function sendModelBuffer(
  request: Request,
  response: Response,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  response.setHeader('Content-Type', contentType)
  response.vary('Accept-Encoding')
  const acceptsGzip = /\bgzip\b/i.test(request.headers['accept-encoding'] ?? '')
  let body = buffer
  if (acceptsGzip && buffer.length >= 4096) {
    body = await gzipAsync(buffer)
    response.setHeader('Content-Encoding', 'gzip')
  }
  response.setHeader('Content-Length', String(body.length))
  try {
    await pipeline(Readable.from(chunkBody(body), { objectMode: false }), response)
  } catch (error) {
    // A client disconnect mid-stream (the editor superseded the load or navigated away) is
    // expected once we've started writing; only surface a genuine error if nothing was sent.
    if (!response.headersSent && !response.writableEnded) throw error
  }
}

function* chunkBody(body: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < body.length; offset += MODEL_BODY_CHUNK_BYTES) {
    yield body.subarray(offset, offset + MODEL_BODY_CHUNK_BYTES)
  }
}

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