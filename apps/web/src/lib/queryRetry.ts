/**
 * Whether a failed query is worth asking again.
 *
 * Owned here rather than inline in the query client so the rule can be tested:
 * it decides how long every failure in the app takes to become visible, and the
 * cost of getting it wrong is invisible in normal use, a screen that sits blank
 * for seconds before admitting something went wrong.
 *
 * Counterpart: `main.tsx` installs it as the QueryClient's default `retry`.
 */
import { ApiError } from './apiClient'

/** Query's own default, kept for the failures that genuinely can differ per attempt. */
const MAX_RETRIES = 3

/**
 * 4xx codes that mean "not now" rather than "no", and so are worth a retry:
 * a request timeout and a rate limit both resolve on their own.
 */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429])

/**
 * A refusal is an ANSWER, not a failure to get one.
 *
 * A 403 returns 403 however many times it is asked, so retrying one buys
 * nothing and costs the backoff: Query's default three retries turned a
 * permission error into about seven seconds of a screen showing neither data
 * nor a reason. Server faults (5xx) and transport failures still retry, because
 * those really do differ between attempts.
 *
 * A non-`ApiError` (a dropped connection, a parse failure) has no status and is
 * treated as retryable: the transport, not the server, is what failed.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = error instanceof ApiError ? error.status : null
  if (status !== null && status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status)) {
    return false
  }
  return failureCount < MAX_RETRIES
}
