/**
 * Fetch-only product news with a validated last-success cache, separate from bundled changelogs.
 * This public fetch never sends account credentials. Cache keys include the feed URL so dev,
 * staging and production cannot replace each other's news. Failures retain the last success.
 */
import { getProductAnnouncementPath, parseProductAnnouncementsCatalog, type ProductAnnouncementsCatalog } from '@printstream/shared'
import { readStoredValue, writeStoredValue } from './browserStorageKeys'
import { announcementLastFetchKeys } from './storageKeys'

export const HOSTED_ANNOUNCEMENTS_FEED_URL = 'https://printstream.app/announcements.json'
const FETCH_TIMEOUT_MS = 10_000

export interface FetchedAnnouncements {
  catalog: ProductAnnouncementsCatalog
  fetchedAt: number
}

/** Reads only a previously fetched, validated catalog; malformed or unavailable storage is ignored. */
export function readCachedAnnouncements(feedUrl: string): FetchedAnnouncements | undefined {
  try {
    const raw = readStoredValue(announcementLastFetchKeys.at(feedUrl))
    if (!raw) return undefined
    const value = JSON.parse(raw) as { catalog?: unknown; fetchedAt?: unknown }
    if (typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt) || value.fetchedAt <= 0) return undefined
    return { catalog: parseProductAnnouncementsCatalog(value.catalog), fetchedAt: value.fetchedAt }
  } catch {
    // Storage is optional; a corrupt old cache must not block an online fetch.
    return undefined
  }
}

/** Fetches and validates before replacing the cache. Cancellation and bounded timeout abort the request. */
export async function fetchAnnouncementsFeed(feedUrl: string, signal: AbortSignal): Promise<FetchedAnnouncements> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timeout = setTimeout(() => controller.abort(new Error('Announcement feed timed out.')), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(feedUrl, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    })
    if (!response.ok) throw new Error(`Announcement feed returned HTTP ${response.status}.`)
    const catalog = parseProductAnnouncementsCatalog(await response.json())
    controller.signal.throwIfAborted()
    const fetched = { catalog, fetchedAt: Date.now() }

    // Best-effort: private browsing or quota pressure may prevent persistence; the news still displays.
    writeStoredValue(announcementLastFetchKeys.at(feedUrl), JSON.stringify(fetched))
    return fetched
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}

/** Articles belong to the feed's host, including staging news that is not published to production yet. */
export function announcementArticleUrl(feedUrl: string, slug: string, pageUrl: string): string {
  return new URL(getProductAnnouncementPath(slug), new URL(feedUrl, pageUrl)).href
}

