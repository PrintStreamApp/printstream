/**
 * Tiny `fetch` wrapper that throws on non-2xx responses with a parsed
 * error message, builds full URLs through `buildApiUrl`, and JSON-encodes
 * payloads. Hooks call this instead of using `fetch` directly.
 */
import { extractErrorMessage } from '@printstream/shared'
import { buildApiUrl } from './apiUrl'
import { readWorkspaceContextHeader } from './workspaceContext'

export interface ApiClientOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  cache?: RequestCache
  headers?: Record<string, string>
  signal?: AbortSignal
  /**
   * Observe the response headers (success or error) before the body is
   * returned/thrown. Used by callers that track server-advertised state such
   * as the `RateLimit-*` budget headers.
   */
  onResponseHeaders?: (headers: Headers) => void
}

/** Error thrown for non-2xx responses; carries the HTTP status and parsed body for callers that
 * need to branch on them (e.g. handling a 409 conflict). `message` is the human-readable error.
 * `retryAfterSeconds` is populated from a 429/503 `Retry-After` header when present. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Parse a numeric `Retry-After` response header (seconds), or null when absent/invalid. */
export function parseRetryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('Retry-After')
  if (!header) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function formatStatusFallback(response: Response): string {
  return response.statusText
    ? `Request failed: ${response.statusText} (${response.status})`
    : `Request failed (${response.status})`
}

async function parseResponsePayload(response: Response, tolerateInvalidJson: boolean): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      return await response.json()
    } catch {
      if (!tolerateInvalidJson) throw new Error('Response body was not valid JSON')
      return ''
    }
  }
  return response.text()
}

export async function apiFetch<T>(path: string, options: ApiClientOptions = {}): Promise<T> {
  const workspaceContext = readWorkspaceContextHeader()
  const response = await fetch(buildApiUrl(path), {
    method: options.method ?? 'GET',
    cache: options.cache,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(workspaceContext ? { 'X-PrintStream-Tenant': workspaceContext } : {}),
      ...(options.headers ?? {})
    },
    signal: options.signal,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  })

  options.onResponseHeaders?.(response.headers)

  if (response.status === 204) return undefined as T

  const payload = await parseResponsePayload(response, !response.ok)

  if (!response.ok) {
    throw new ApiError(extractErrorMessage(payload, formatStatusFallback(response)), response.status, payload, parseRetryAfterSeconds(response))
  }
  return payload as T
}
