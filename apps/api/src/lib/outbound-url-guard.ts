/**
 * Guards for server-side outbound HTTP fetches (SSRF hardening).
 *
 * Several features fetch a URL the API itself requests on the server: the ntfy
 * topic a tenant configures, the firmware binary scraped from Bambu's download
 * page, etc. Without a guard, an operator/tenant-supplied URL can point the API
 * at loopback, link-local, or the cloud metadata endpoint (169.254.169.254) and
 * use it as a request proxy into the trust boundary.
 *
 * `assertSafeOutboundUrl` enforces, in order:
 *  1. a parseable URL with an allowed scheme (https only by default; opt into
 *     http for self-hosted services like a LAN ntfy),
 *  2. the host is not loopback / unspecified / link-local / a known metadata IP,
 *  3. when `allowedHosts` is given, the host equals or is a subdomain of one of
 *     them (used to pin firmware downloads to Bambu's CDN).
 *
 * Note on scope: this validates the literal host. It deliberately does NOT block
 * general RFC-1918 private ranges, because self-hosted deployments legitimately
 * reach services on their own LAN (e.g. a self-hosted ntfy). It also does not yet
 * resolve hostnames to defeat DNS-rebinding; pinning with `allowedHosts` is the
 * strong control where the destination is known. Resolve-and-recheck hardening
 * is a worthwhile follow-up for the open-ended (ntfy) case.
 */
import { isIP } from 'node:net'

export interface OutboundUrlOptions {
  /** Allow `http:` in addition to `https:`. Default: https only. */
  allowHttp?: boolean
  /**
   * If set, the URL host must equal one of these or be a subdomain of one
   * (e.g. `['bblmw.com']` allows `public-cdn.bblmw.com`). Case-insensitive.
   */
  allowedHosts?: readonly string[]
}

/** Hostnames that always resolve into the local host and are never a valid target. */
const BLOCKED_HOSTNAMES = new Set(['localhost'])

/**
 * Validates a server-fetched URL and returns the parsed `URL`. Throws a plain
 * `Error` with a user-safe message on any violation (callers at a route boundary
 * should translate it to a 400; delivery paths should log and skip).
 */
export function assertSafeOutboundUrl(raw: string, options: OutboundUrlOptions = {}): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid URL.')
  }

  const scheme = url.protocol.toLowerCase()
  const schemeAllowed = scheme === 'https:' || (options.allowHttp === true && scheme === 'http:')
  if (!schemeAllowed) {
    throw new Error(options.allowHttp ? 'URL must use http or https.' : 'URL must use https.')
  }

  // url.hostname keeps IPv6 brackets; strip them for the IP/hostname checks.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) throw new Error('URL host is not allowed.')
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error('URL host is not allowed.')
  if (isIP(host) && isBlockedAddress(host)) throw new Error('URL host is not allowed.')

  if (options.allowedHosts && !hostMatchesAllowList(host, options.allowedHosts)) {
    throw new Error('URL host is not on the allow-list.')
  }

  return url
}

/** True when an IP literal is loopback, unspecified, link-local, or metadata. */
function isBlockedAddress(host: string): boolean {
  const version = isIP(host)
  if (version === 4) {
    const [a, b] = host.split('.').map(Number)
    if (a === 127) return true // 127.0.0.0/8 loopback
    if (a === 0) return true // 0.0.0.0/8 "this network" / unspecified
    if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (incl. metadata 169.254.169.254)
    return false
  }
  if (version === 6) {
    const normalized = host.replace(/%.*$/, '') // drop any zone id
    if (normalized === '::1' || normalized === '::') return true // loopback / unspecified
    if (normalized.startsWith('fe80')) return true // link-local
    // IPv4-mapped IPv6, either dotted (::ffff:127.0.0.1) or, as `URL` normalizes
    // it, hex (::ffff:7f00:1) — recheck the embedded IPv4.
    const mappedDotted = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (mappedDotted?.[1]) return isBlockedAddress(mappedDotted[1])
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    const highHex = mappedHex?.[1]
    const lowHex = mappedHex?.[2]
    if (highHex && lowHex) {
      const high = parseInt(highHex, 16)
      const low = parseInt(lowHex, 16)
      const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
      return isBlockedAddress(ipv4)
    }
    return false
  }
  return false
}

/** Host equals an allowed host or is a subdomain of one. */
function hostMatchesAllowList(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((allowed) => {
    const base = allowed.toLowerCase().replace(/^\.+/, '')
    return host === base || host.endsWith(`.${base}`)
  })
}
