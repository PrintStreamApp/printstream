/**
 * HMS (Health Management System) code lookup.
 *
 * Bambu printers report errors as two uint32 fields per entry, `attr` and
 * `code`, plus an occasional top-level `print_error` (single uint32).
 * The canonical Bambu identifier is the 16-hex-character concatenation
 * `AAAAAAAA` + `CCCCCCCC` (for HMS) or 8-character `CCCCCCCC` (for the
 * `device_error` namespace). Bambu publishes a JSON dictionary of these
 * codes at https://e.bambulab.com/query.php?lang=en.
 *
 * This module owns:
 *   - fetching that dictionary on startup and refreshing it daily
 *   - caching it in memory and on disk (so we work offline after the first
 *     successful fetch)
 *   - synchronous lookups by canonical code
 *   - small formatters for the two code shapes
 *
 * The parser falls back gracefully: if the dictionary is empty or the
 * code is unknown, callers receive `null` and present a "look up code"
 * link to the user instead.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from './env.js'

const DICTIONARY_URL = 'https://e.bambulab.com/query.php?lang=en'
const CACHE_FILE = path.resolve(path.dirname(env.LIBRARY_DIR), 'hms-codes.json')
const REFRESH_MS = 24 * 60 * 60 * 1000
const GENERIC_DEVICE_TYPE = '__generic__'

interface BambuEntry {
  ecode?: unknown
  intro?: unknown
}

interface BambuDictionary {
  data?: {
    device_hms?: { en?: BambuEntry[] }
    device_error?: { en?: BambuEntry[] }
  }
}

type DictionaryFetcher = typeof fetch

interface DiskDictionaryLoadResult {
  count: number
  fresh: boolean
}

const messagesByDeviceType = new Map<string, Map<string, string>>()
const initializedDeviceTypes = new Set<string>()
const inFlightRefreshes = new Map<string, Promise<number>>()
let started = false
let refreshTimer: ReturnType<typeof setInterval> | null = null
let dictionaryFetcher: DictionaryFetcher = fetch

/** Convert a uint32 to an uppercase 8-hex-character string. */
function toHex8(value: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

function getDeviceTypeKey(deviceType?: string | null): string {
  return normalizeDeviceType(deviceType) ?? GENERIC_DEVICE_TYPE
}

function getCacheFile(deviceType?: string | null): string {
  const normalized = normalizeDeviceType(deviceType)
  if (!normalized) return CACHE_FILE
  return path.resolve(path.dirname(env.LIBRARY_DIR), `hms-codes.${normalized}.json`)
}

function buildDictionaryIndex(dict: BambuDictionary): Map<string, string> {
  const nextMessages = new Map<string, string>()
  const groups = [dict.data?.device_hms?.en, dict.data?.device_error?.en]
  for (const list of groups) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (typeof entry?.ecode !== 'string') continue
      const intro = typeof entry.intro === 'string' ? entry.intro.replace(/\s+/g, ' ').trim() : ''
      if (!intro) continue
      nextMessages.set(entry.ecode.toUpperCase(), intro)
    }
  }
  return nextMessages
}

function setDictionaryIndex(dict: BambuDictionary, deviceType?: string | null): number {
  const nextMessages = buildDictionaryIndex(dict)
  messagesByDeviceType.set(getDeviceTypeKey(deviceType), nextMessages)
  initializedDeviceTypes.add(getDeviceTypeKey(deviceType))
  return nextMessages.size
}

export function normalizeDeviceType(deviceType?: string | null): string | null {
  if (typeof deviceType !== 'string') return null
  const normalized = deviceType.trim().slice(0, 3).toUpperCase()
  return normalized.length === 3 ? normalized : null
}

export function getHmsDeviceType(serialOrDeviceId?: string | null): string | null {
  return normalizeDeviceType(serialOrDeviceId)
}

export function getHmsDictionaryUrl(deviceType?: string | null): string {
  const url = new URL(DICTIONARY_URL)
  const normalized = normalizeDeviceType(deviceType)
  if (normalized) {
    url.searchParams.set('d', normalized)
  }
  return url.toString()
}

/**
 * Build the canonical 16-character HMS identifier from the `attr` and
 * `code` uint32s reported by the printer.
 */
export function formatHmsCode(attr: number, code: number): string {
  return `${toHex8(attr)}${toHex8(code)}`
}

/** Build the canonical 8-character device_error identifier. */
export function formatPrintErrorCode(code: number): string {
  return toHex8(code)
}

/** Look up a human-readable description for a canonical HMS or device_error code. */
export function lookupHmsMessage(canonicalCode: string, deviceType?: string | null): string | null {
  const normalizedCode = canonicalCode.toUpperCase()
  const deviceSpecificMessages = messagesByDeviceType.get(getDeviceTypeKey(deviceType))
  const message = deviceSpecificMessages?.get(normalizedCode)
    ?? messagesByDeviceType.get(GENERIC_DEVICE_TYPE)?.get(normalizedCode)
  return message && message.length > 0 ? message : null
}

function isFreshCacheFile(mtimeMs: number, nowMs = Date.now()): boolean {
  return nowMs - mtimeMs < REFRESH_MS
}

async function loadFromDisk(deviceType?: string | null): Promise<DiskDictionaryLoadResult> {
  try {
    const cacheFile = getCacheFile(deviceType)
    const [raw, info] = await Promise.all([
      readFile(cacheFile, 'utf8'),
      stat(cacheFile)
    ])
    const count = setDictionaryIndex(JSON.parse(raw) as BambuDictionary, deviceType)
    return { count, fresh: count > 0 && isFreshCacheFile(info.mtimeMs) }
  } catch {
    return { count: 0, fresh: false }
  }
}

async function refreshFromNetwork(deviceType?: string | null): Promise<number> {
  const response = await dictionaryFetcher(getHmsDictionaryUrl(deviceType), {
    headers: { Accept: 'application/json' },
    // Bambu's CDN responds quickly; cap the wait so a slow network
    // never blocks startup of the printer manager.
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    throw new Error(`HMS dictionary fetch failed: ${response.status}`)
  }
  const text = await response.text()
  const json = JSON.parse(text) as BambuDictionary
  const count = setDictionaryIndex(json, deviceType)
  if (count > 0) {
    const cacheFile = getCacheFile(deviceType)
    await mkdir(path.dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, text, 'utf8')
  }
  return count
}

async function refreshDictionary(deviceType?: string | null): Promise<number> {
  const key = getDeviceTypeKey(deviceType)
  const inFlight = inFlightRefreshes.get(key)
  if (inFlight) return await inFlight

  const refreshPromise = refreshFromNetwork(deviceType).finally(() => {
    inFlightRefreshes.delete(key)
  })
  inFlightRefreshes.set(key, refreshPromise)
  return await refreshPromise
}

export async function ensureHmsDeviceTypeDictionary(deviceType?: string | null): Promise<void> {
  const normalized = normalizeDeviceType(deviceType)
  if (!normalized || initializedDeviceTypes.has(normalized)) return

  initializedDeviceTypes.add(normalized)
  const fromDisk = await loadFromDisk(normalized)
  if (fromDisk.count > 0) {
    console.log(`HMS dictionary loaded from cache for ${normalized} (${fromDisk.count} entries)`)
  }
  if (fromDisk.fresh) {
    return
  }

  try {
    const count = await refreshDictionary(normalized)
    console.log(`HMS dictionary refreshed from Bambu for ${normalized} (${count} entries)`)
  } catch (error) {
    console.warn(`HMS dictionary refresh failed for ${normalized}:`, (error as Error).message)
  }
}

/**
 * Initialize the dictionary. Loads the disk cache immediately so lookups
 * work right away, then attempts a network refresh in the background and
 * schedules subsequent refreshes once a day. Safe to call multiple times.
 */
export async function startHmsCodeService(): Promise<void> {
  if (started) return
  started = true
  initializedDeviceTypes.add(GENERIC_DEVICE_TYPE)

  const fromDisk = await loadFromDisk()
  if (fromDisk.count > 0) {
    console.log(`HMS dictionary loaded from cache (${fromDisk.count} entries)`)
  }

  const refreshAll = async () => {
    try {
      const count = await refreshDictionary()
      console.log(`HMS dictionary refreshed from Bambu (${count} entries)`)
    } catch (error) {
      console.warn('HMS dictionary refresh failed:', (error as Error).message)
    }

    for (const deviceType of initializedDeviceTypes) {
      if (deviceType === GENERIC_DEVICE_TYPE) continue
      try {
        const count = await refreshDictionary(deviceType)
        console.log(`HMS dictionary refreshed from Bambu for ${deviceType} (${count} entries)`)
      } catch (error) {
        console.warn(`HMS dictionary refresh failed for ${deviceType}:`, (error as Error).message)
      }
    }
  }

  if (!fromDisk.fresh) {
    void refreshAll()
  }
  refreshTimer = setInterval(() => {
    void refreshAll()
  }, REFRESH_MS)
  refreshTimer.unref()
}

export function ingestHmsDictionaryForTests(dict: BambuDictionary, deviceType?: string | null): void {
  setDictionaryIndex(dict, deviceType)
}

export function resetHmsCodeServiceForTests(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  messagesByDeviceType.clear()
  initializedDeviceTypes.clear()
  inFlightRefreshes.clear()
  dictionaryFetcher = fetch
  started = false
}

export function setHmsDictionaryFetcherForTests(fetcher: DictionaryFetcher | null): void {
  dictionaryFetcher = fetcher ?? fetch
}

export function isFreshHmsCacheFileForTests(mtimeMs: number, nowMs: number): boolean {
  return isFreshCacheFile(mtimeMs, nowMs)
}
