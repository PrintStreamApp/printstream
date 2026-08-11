/**
 * Dev-only forwarding middleware for plain HTTP `/api` traffic (wired in `vite.config.ts`).
 *
 * Replaces Vite's `server.proxy` entry for `/api`. That entry rides the bundled http-proxy-3,
 * which wedges requests that accompany or FOLLOW an aborted large response — the request never
 * completes and never errors. The editor provokes the trigger constantly because React StrictMode
 * fires each archive fetch twice in dev and aborts one. MEASURED in-browser against the real
 * `/api/library/:id/archive` (17MB, caching disabled; each cycle: one concurrent download aborted
 * mid-body, the survivor and a follow-up fetch must complete within 10s): http-proxy-3 1.23.3
 * hung 11 of 12 cycles; this middleware hung 0 of 20. An earlier round measured 5/20 against a
 * 4.6MB body, so the hang rate scales with body size — either way the class dies here. The two
 * WebSocket entries (`/api/bridge-runtime/connect`, `/ws`) stay on Vite's proxy: upgrades arrive
 * on the server's `upgrade` event and never pass through this connect middleware.
 *
 * Correctness rules this module owns:
 *  - one fresh upstream connection per request (`agent: false`) — no keep-alive reuse, so an
 *    aborted transfer can never poison a socket a later request would inherit; localhost
 *    connection setup is trivial at dev request rates;
 *  - a client abort tears the upstream request down immediately (`close` before `writableEnded`
 *    → `destroy()`), and the teardown's own ECONNRESET is expected and not logged;
 *  - an upstream failure answers 502 while headers are unsent, else destroys the response —
 *    the caller always observes an ending, never silence;
 *  - hop-by-hop headers are stripped in both directions (node manages its own connection
 *    framing; copying upstream's `transfer-encoding` alongside node's chunking corrupts bodies).
 */
import http from 'node:http'
import type { Plugin } from 'vite'

/** Hop-by-hop headers owned by each individual connection, never forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']

function withoutHopByHopHeaders<T extends Record<string, unknown>>(headers: T): T {
  const cleaned = { ...headers }
  for (const name of HOP_BY_HOP_HEADERS) delete cleaned[name]
  return cleaned
}

export function devApiProxy(apiPort: string): Plugin {
  return {
    name: 'printstream:dev-api-proxy',
    apply: 'serve',
    configureServer(server) {
      // Registered inside configureServer (not its returned thunk), so it runs BEFORE Vite's
      // internal middlewares and `/api` requests never enter the transform pipeline.
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (url !== '/api' && !url.startsWith('/api/') && !url.startsWith('/api?')) return next()

        let clientAborted = false
        const proxyReq = http.request(
          {
            host: 'localhost',
            port: Number(apiPort),
            path: url,
            method: req.method,
            headers: { ...withoutHopByHopHeaders(req.headers), host: `localhost:${apiPort}` },
            agent: false
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, withoutHopByHopHeaders(proxyRes.headers))
            proxyRes.pipe(res)
            proxyRes.on('error', () => res.destroy())
          }
        )

        req.pipe(proxyReq)
        req.on('error', () => proxyReq.destroy())
        res.on('close', () => {
          // `close` also fires after a normal finish; only an unfinished response is an abort.
          if (!res.writableEnded) {
            clientAborted = true
            proxyReq.destroy()
          }
        })
        proxyReq.on('error', (error) => {
          // Our own teardown after a client abort surfaces here as ECONNRESET — expected, silent.
          if (clientAborted) return
          console.warn(`[dev-api-proxy] ${req.method} ${url} upstream failed: ${error.message}`)
          if (res.headersSent) {
            res.destroy()
          } else {
            res.writeHead(502, { 'content-type': 'text/plain' })
            res.end('dev api proxy: upstream request failed')
          }
        })
      })
    }
  }
}
