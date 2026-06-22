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
 * the resource directives are exercised during development.
 */
const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
  'form-action': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'script-src': ["'self'", "'unsafe-inline'"],
  'connect-src': ["'self'"],
  'worker-src': ["'self'", 'blob:']
}

/** Serializes the policy into a `Content-Security-Policy` header value. */
export function buildContentSecurityPolicy(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ')
}
