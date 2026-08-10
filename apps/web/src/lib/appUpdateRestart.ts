/**
 * Waits out the native app's in-place update restart: after
 * `POST /api/app/update/start` is accepted the server goes down, swaps its
 * binary, and comes back as a DIFFERENT build — so "it's back" is a revision
 * change, not a reachable endpoint (the dying process can answer a poll with
 * the old build for a while). Counterpart: `AppVersionFooter.tsx`, which
 * reloads the page once this resolves.
 *
 * Injectable fetch/sleep because the real thing takes minutes and hits the
 * network; tests drive it with stubs.
 */
import type { AppVersionResponse } from '@printstream/shared'

const DEFAULT_POLL_INTERVAL_MS = 3_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000

export interface WaitForNewBuildOptions {
  /** The build the page was served by, from `/api/app/version` before the update. */
  previousRevision: string | null
  /** Poll of `/api/app/version`; must RESOLVE null on network errors (the app is mid-restart). */
  fetchVersion: () => Promise<AppVersionResponse | null>
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Resolves true once a different build answers, false on timeout. */
export async function waitForNewBuild(options: WaitForNewBuildOptions): Promise<boolean> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())

  const startedAt = now()
  while (now() - startedAt < timeoutMs) {
    await sleep(intervalMs)
    const version = await options.fetchVersion()
    const revision = version?.revision ?? null
    // A null revision is the old process answering while shutting down or a
    // failed poll; only a REAL, different revision proves the new build is up.
    if (revision != null && revision !== options.previousRevision) return true
  }
  return false
}
