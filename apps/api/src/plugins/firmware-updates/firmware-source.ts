/**
 * Bambu Lab firmware version source.
 *
 * Two upstream pages give complementary information:
 *
 * - The official wiki release-history pages always list the very latest
 *   firmware version per model and tend to be updated first. They do
 *   not, however, publish download URLs.
 * - The bambulab.com firmware-download pages embed a Next.js
 *   `__NEXT_DATA__` payload containing per-version download URLs and
 *   release notes, but typically lag the wiki by a day or two.
 *
 * This module merges the two: the wiki is the source of truth for the
 * "latest version" pointer, while the download page is queried
 * separately to obtain a download URL for any specific version the
 * user wants to install.
 *
 * All upstream calls are best-effort and aggressively cached (1h TTL):
 * PrintStream is not Bambu Lab's customer, so we should never hammer
 * their site even when many printers ask for updates at once.
 */

const BAMBU_FIRMWARE_BASE = 'https://bambulab.com'
const FIRMWARE_PAGE = '/en/support/firmware-download/all'
const BAMBU_WIKI_BASE = 'https://wiki.bambulab.com'

const HTTP_TIMEOUT_MS = 30_000
const CACHE_TTL_MS = 60 * 60 * 1000
const USER_AGENT =
  'Mozilla/5.0 (PrintStream firmware-updates plugin)'

/** Map of printstream `PrinterModel` enum members to bambulab.com API keys. */
const MODEL_TO_API_KEY: Record<string, string> = {
  X1C: 'x1',
  X1E: 'x1e',
  P1S: 'p1',
  P1P: 'p1',
  A1: 'a1',
  A1mini: 'a1-mini',
  H2D: 'h2d'
}

const API_KEY_TO_WIKI_PATH: Record<string, string> = {
  x1: '/en/x1/manual/X1-X1C-firmware-release-history',
  x1e: '/en/x1/manual/X1E-firmware-release-history',
  p1: '/en/p1/manual/p1p-firmware-release-history',
  a1: '/en/a1/manual/a1-firmware-release-history',
  'a1-mini': '/en/a1-mini/manual/a1-mini-firmware-release-history',
  h2d: '/en/h2d/manual/h2d-firmware-release-history'
}

export interface FirmwareVersion {
  version: string
  /** Empty string when the version is announced on the wiki but not yet on the download page. */
  downloadUrl: string
  releaseNotes: string | null
  releaseTime: string | null
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export interface FirmwareSourceLogger {
  warn(message: string, meta?: unknown): void
}

/** Fetch with a hard timeout so a hung upstream cannot stall a plugin route. */
async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT }
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Resolve a `Printer.model` value to the bambulab.com API key, or `null`. */
export function resolveApiKey(model: string | null | undefined): string | null {
  if (!model) return null
  return MODEL_TO_API_KEY[model] ?? null
}

/**
 * Compare two dotted-quad firmware version strings.
 *
 * Returns 1 if `a > b`, -1 if `a < b`, and 0 when equal or unparseable.
 * Missing components are treated as 0 so `01.08.05` and `01.08.05.00`
 * compare equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 4; i += 1) {
    const av = pa[i] ?? 0
    const bv = pb[i] ?? 0
    if (av > bv) return 1
    if (av < bv) return -1
  }
  return 0
}

function parseVersion(value: string): number[] | null {
  if (typeof value !== 'string') return null
  const parts = value.trim().split('.')
  if (parts.length === 0) return null
  const out: number[] = []
  for (const part of parts) {
    const n = Number.parseInt(part, 10)
    if (!Number.isFinite(n)) return null
    out.push(n)
  }
  while (out.length < 4) out.push(0)
  return out
}

export class FirmwareSource {
  private wikiVersionsCache = new Map<string, CacheEntry<Array<{ version: string; releaseDate: string | null }>>>()
  private downloadVersionsCache = new Map<string, CacheEntry<FirmwareVersion[]>>()

  constructor(private readonly logger: FirmwareSourceLogger) {}

  /**
   * Get all known versions for a printer model, newest first. The list
   * is the union of wiki versions (always present, may lack a download
   * URL) and download-page versions (always have URLs).
   */
  async listVersions(model: string | null | undefined, signal?: AbortSignal): Promise<FirmwareVersion[]> {
    const apiKey = resolveApiKey(model)
    if (!apiKey) return []

    const [wiki, download] = await Promise.all([
      this.fetchWikiVersions(apiKey, signal),
      this.fetchDownloadVersions(apiKey, signal)
    ])

    const byVersion = new Map<string, FirmwareVersion>()
    for (const entry of download) {
      if (entry.version) byVersion.set(entry.version, entry)
    }

    const merged: FirmwareVersion[] = []
    const seen = new Set<string>()
    for (const w of wiki) {
      if (seen.has(w.version)) continue
      seen.add(w.version)
      const fromDownload = byVersion.get(w.version)
      if (fromDownload) {
        merged.push(fromDownload)
      } else {
        merged.push({
          version: w.version,
          downloadUrl: '',
          releaseNotes: null,
          releaseTime: w.releaseDate
        })
      }
    }
    for (const entry of download) {
      if (!entry.version || seen.has(entry.version)) continue
      seen.add(entry.version)
      merged.push(entry)
    }

    merged.sort((a, b) => compareVersions(b.version, a.version))
    return merged
  }

  /** Latest version for a model, or `null` if the model is unknown / lookup failed. */
  async latestVersion(model: string | null | undefined, signal?: AbortSignal): Promise<FirmwareVersion | null> {
    const versions = await this.listVersions(model, signal)
    return versions[0] ?? null
  }

  /** Look up a specific version's record (with download URL when available). */
  async findVersion(model: string | null | undefined, version: string, signal?: AbortSignal): Promise<FirmwareVersion | null> {
    const versions = await this.listVersions(model, signal)
    return versions.find((entry) => entry.version === version) ?? null
  }

  // --- internal helpers -------------------------------------------------

  private async fetchWikiVersions(apiKey: string, signal?: AbortSignal): Promise<Array<{ version: string; releaseDate: string | null }>> {
    const cached = this.wikiVersionsCache.get(apiKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    const path = API_KEY_TO_WIKI_PATH[apiKey]
    if (!path) return []

    let html = ''
    try {
      const response = await fetchWithTimeout(`${BAMBU_WIKI_BASE}${path}`, signal)
      if (!response.ok) {
        this.logger.warn(`wiki firmware page ${apiKey} returned ${response.status}`)
        return []
      }
      html = await response.text()
    } catch (error) {
      this.logger.warn(`wiki firmware fetch failed for ${apiKey}`, error)
      return []
    }

    const seen = new Set<string>()
    const out: Array<{ version: string; releaseDate: string | null }> = []

    // Primary: heading-anchor ids, e.g. id="h-01030000-20260303" or id="h-0102000020260409".
    const anchorRe = /id="h-(\d{2})(\d{2})(\d{2})(\d{2})-?(\d{8})"/g
    for (const match of html.matchAll(anchorRe)) {
      const version = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`
      if (seen.has(version)) continue
      seen.add(version)
      out.push({ version, releaseDate: match[5] ?? null })
    }

    // Fallback: heading text "XX.XX.XX.XX (YYYYMMDD)" with ASCII or full-width parens.
    if (out.length === 0) {
      const textRe = /(\d{2}\.\d{2}\.\d{2}\.\d{2})\s*[(\uff08](\d{8})[)\uff09]/g
      for (const match of html.matchAll(textRe)) {
        const version = match[1]!
        if (seen.has(version)) continue
        seen.add(version)
        out.push({ version, releaseDate: match[2] ?? null })
      }
    }

    this.wikiVersionsCache.set(apiKey, { value: out, expiresAt: Date.now() + CACHE_TTL_MS })
    return out
  }

  private async fetchDownloadVersions(apiKey: string, signal?: AbortSignal): Promise<FirmwareVersion[]> {
    const cached = this.downloadVersionsCache.get(apiKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    try {
      const url = `${BAMBU_FIRMWARE_BASE}${FIRMWARE_PAGE.replace('/all', `/${apiKey}`)}`
      const response = await fetchWithTimeout(url, signal)
      if (!response.ok) return []
      const html = await response.text()
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
      if (!nextDataMatch) {
        this.logger.warn(`firmware-download page ${apiKey} did not include __NEXT_DATA__`)
        return []
      }
      const nextDataJson = nextDataMatch[1]
      if (!nextDataJson) {
        this.logger.warn(`firmware-download page ${apiKey} had an empty __NEXT_DATA__ payload`)
        return []
      }
      const data = JSON.parse(nextDataJson) as {
        props?: {
          pageProps?: {
            printerMap?: Record<string, { versions?: Array<Record<string, unknown>> }>
          }
        }
        pageProps?: {
          printerMap?: Record<string, { versions?: Array<Record<string, unknown>> }>
        }
      }
      const versions = data.props?.pageProps?.printerMap?.[apiKey]?.versions
        ?? data.pageProps?.printerMap?.[apiKey]?.versions
        ?? []
      const out: FirmwareVersion[] = []
      for (const v of versions) {
        const version = typeof v.version === 'string' ? v.version : ''
        if (!version) continue
        out.push({
          version,
          downloadUrl: typeof v.url === 'string' ? v.url : '',
          releaseNotes: typeof v.release_notes_en === 'string' ? v.release_notes_en : null,
          releaseTime: typeof v.release_time === 'string' ? v.release_time : null
        })
      }
      this.downloadVersionsCache.set(apiKey, { value: out, expiresAt: Date.now() + CACHE_TTL_MS })
      return out
    } catch (error) {
      this.logger.warn(`download-page firmware fetch failed for ${apiKey}`, error)
      return []
    }
  }
}
