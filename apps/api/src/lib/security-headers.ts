/**
 * Helmet options for the API's response security headers.
 *
 * Exists as its own module so the one environment-dependent decision here — whether to send
 * HSTS — can be tested without importing `app.ts`, which builds the whole Express app (and its
 * plugins and database wiring) at import time.
 *
 * Counterpart: `app.ts`, the only caller.
 */

export interface SecurityHeaderOptions {
  /** Off: the camera proxy serves MJPEG / blob: frames that the strict default would block. */
  crossOriginResourcePolicy: false
  /** Off: `content-security-policy.ts` builds ours, so helmet's default must not also emit one. */
  contentSecurityPolicy: false
  /** See `shouldSendStrictTransportSecurity`. */
  strictTransportSecurity: boolean
}

/**
 * HSTS is correct only where the deployment terminates TLS.
 *
 * The header instructs the BROWSER never to use http for this host again, and browsers honour it
 * per hostname — `localhost` included. A single dev response therefore pins localhost to https for
 * a year, and every later plain-HTTP request fails at the transport with a certificate error, long
 * after the header stopped being sent. Clearing it needs a manual browser reset, so the cost of
 * sending it wrongly is far higher than the cost of omitting it in dev.
 */
export function shouldSendStrictTransportSecurity(nodeEnv: string): boolean {
  return nodeEnv === 'production'
}

export function buildSecurityHeaderOptions(nodeEnv: string): SecurityHeaderOptions {
  return {
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
    strictTransportSecurity: shouldSendStrictTransportSecurity(nodeEnv)
  }
}
