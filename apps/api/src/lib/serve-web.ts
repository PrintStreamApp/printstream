/**
 * Single-container web serving. When a web `dist` directory is configured (via
 * `SERVE_WEB_DIR`), the API serves the built SPA on its own port alongside
 * `/api` and `/ws`, collapsing the separate nginx `web` container into one
 * image. No-op when no directory is given (the split topology, where nginx or a
 * CDN serves the SPA and the API only handles `/api` + `/ws`).
 *
 * The cache headers here are the ones the PWA depends on (and are what the
 * former standalone web/nginx container set): hashed `/assets/*` are immutable
 * for a year, while the PWA entry files (`index.html`, `sw.js`, `registerSW.js`,
 * `push-handler.js`, `manifest.webmanifest`) are `no-store` so app updates and
 * push subscriptions never pin to a stale service worker. `sw.js` also gets
 * `Service-Worker-Allowed: /` so the worker can claim the whole origin (Web
 * Push requires it).
 */
import express from 'express'
import type { Express, Response } from 'express'
import path from 'node:path'

const NO_STORE = 'no-store, no-cache, must-revalidate, proxy-revalidate'

/** PWA entry files that must never be cached, matched by basename. */
const NO_STORE_FILES = new Set([
  'index.html',
  'sw.js',
  'registerSW.js',
  'push-handler.js',
  'manifest.webmanifest'
])

/**
 * Marks a response uncacheable with the same header set the SPA entry files
 * use. Exported for handlers that serve alternate flavors of `index.html`
 * (e.g. the cloud module's SEO-enriched marketing pages) so their caching
 * behavior stays identical to the plain SPA fallback.
 */
export function applyNoStore(response: Response): void {
  response.setHeader('Cache-Control', NO_STORE)
  response.setHeader('Pragma', 'no-cache')
  response.setHeader('Expires', '0')
}

/**
 * Mounts SPA static serving + history fallback on `app` when `webDir` is set.
 * Call this after all `/api` routes (so the API always wins) and before the
 * error handler. Returns true when serving was mounted, false when `webDir` is
 * empty/undefined (split topology).
 */
export function installWebApp(app: Express, webDir: string | undefined): boolean {
  if (!webDir) return false
  const root = path.resolve(webDir)
  const assetsPrefix = `${path.sep}assets${path.sep}`

  app.use(
    express.static(root, {
      index: false,
      setHeaders(response, filePath) {
        const name = path.basename(filePath)
        if (NO_STORE_FILES.has(name)) {
          applyNoStore(response)
        } else if (filePath.includes(assetsPrefix)) {
          // Vite emits content-hashed asset filenames, so these are safe to
          // cache forever; a new build changes the name, not the contents.
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
        if (name === 'sw.js') response.setHeader('Service-Worker-Allowed', '/')
      }
    })
  )

  // History-API fallback: any GET that did not match a static file and is not an
  // API or WebSocket path serves index.html, so client-side routes resolve on a
  // hard refresh or a shared deep link. Mounted as path-less middleware to dodge
  // Express 5's stricter wildcard route syntax.
  app.use((request, response, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next()
    const { path: requestPath } = request
    if (requestPath === '/api' || requestPath.startsWith('/api/')) return next()
    if (requestPath === '/ws' || requestPath.startsWith('/ws/')) return next()
    applyNoStore(response)
    response.sendFile(path.join(root, 'index.html'), (error) => {
      if (error) next(error)
    })
  })

  return true
}
