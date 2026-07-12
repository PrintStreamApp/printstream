/**
 * Content-Security-Policy for the SPA the API serves.
 *
 * Helmet's CSP was previously disabled entirely, leaving the React app with no
 * second line of defense against an injected/compromised script. This policy
 * restores defense-in-depth while allowing what the app genuinely needs:
 *
 * - `img-src`/`media-src 'self' data: blob:` — camera frames and cover/thumbnail
 *   images are rendered from `blob:`/`data:` object URLs built off WebSocket JPEG
 *   frames and proxied MJPEG/snapshot bytes (the case the old "CSP off" comment
 *   worried about). These are allowed; everything else cross-origin is not.
 * - `connect-src 'self'` — HTTP + same-origin WebSocket; blocks exfiltration of
 *   data to an attacker-controlled host, the usual XSS payload goal.
 * - `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
 *   `form-action 'self'` — kill plugin embeds, `<base>` hijacking, clickjacking,
 *   and form-action hijacking outright.
 * - `worker-src 'self' blob:` — the model-studio mesh-parsing web worker.
 *
 * `script-src` still allows `'unsafe-inline'` because vite-plugin-pwa inlines a
 * small service-worker registration snippet into index.html; tightening that to a
 * hash/nonce is a worthwhile follow-up. Even with it, the policy meaningfully
 * raises the bar (no cross-origin script/connect/object).
 *
 * Rolled out report-only by default (`CSP_ENFORCE=false`) so a missed directive
 * surfaces as a console report instead of a broken page; flip `CSP_ENFORCE=true`
 * once validated. The dev server (vite.config) enforces an equivalent policy so
 * the resource directives are exercised during development. Violations (in both
 * modes) are POSTed to the `routes/csp-report.ts` sink via `report-uri`, so
 * real-user regressions surface in the server logs, not just user consoles.
 */
// Paddle Billing checkout (cloud-only). Paddle.js is served from `cdn.paddle.com`
// and opens the checkout in an iframe from `*.paddle.com` (e.g. `buy.paddle.com`,
// `sandbox-buy.paddle.com`), calling Paddle's APIs and loading card-brand images
// from the same host set. Allow-listing these is inert on self-hosted/OSS builds
// (which never load Paddle.js) — it only widens what the cloud checkout needs.
const PADDLE = 'https://*.paddle.com'

// Cloudflare Web Analytics. When a deployment is proxied by Cloudflare with
// Web Analytics enabled, the edge injects its RUM beacon into served HTML:
// a script from `static.cloudflareinsights.com` that POSTs measurements to
// `cloudflareinsights.com` (newer beacons use same-origin `/cdn-cgi/rum`,
// which `'self'` already covers). The app never references these hosts, so
// the allowance is inert unless that edge feature is actually on.
const CLOUDFLARE_INSIGHTS_SCRIPT = 'https://static.cloudflareinsights.com'
const CLOUDFLARE_INSIGHTS_BEACON = 'https://cloudflareinsights.com'

const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
  'form-action': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:', PADDLE],
  'media-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'style-src': ["'self'", "'unsafe-inline'", PADDLE],
  'script-src': ["'self'", "'unsafe-inline'", PADDLE, CLOUDFLARE_INSIGHTS_SCRIPT],
  'connect-src': ["'self'", PADDLE, CLOUDFLARE_INSIGHTS_BEACON],
  'frame-src': ["'self'", PADDLE],
  'worker-src': ["'self'", 'blob:']
}

export interface ContentSecurityPolicyOptions {
  /**
   * Origin of a first-party analytics tracker (e.g. a self-hosted Umami at
   * `https://analytics.example.com`). Trackers of that shape need exactly two
   * allowances: loading their script (`script-src`) and posting their event
   * beacons (`connect-src`) — nothing wider. Unset on installs without
   * cross-origin analytics.
   */
  analyticsOrigin?: string | null
  /**
   * Path (or URL) violation reports are POSTed to via `report-uri`. The
   * deprecated-but-universal directive is used deliberately: `report-to`
   * requires a `Reporting-Endpoints` header and still lacks Firefox support.
   */
  reportUri?: string | null
}

/** Serializes the policy into a `Content-Security-Policy` header value. */
export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions = {}): string {
  const directives = Object.entries(CSP_DIRECTIVES).map(([directive, sources]) => {
    const extended = options.analyticsOrigin && (directive === 'script-src' || directive === 'connect-src')
      ? [...sources, options.analyticsOrigin]
      : sources
    return `${directive} ${extended.join(' ')}`
  })
  if (options.reportUri) directives.push(`report-uri ${options.reportUri}`)
  return directives.join('; ')
}
