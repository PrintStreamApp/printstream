/**
 * Identity of the web bundle THIS SERVER IS SERVING.
 *
 * Owns one fact and publishes it on two channels: the `hello` WS frame
 * (`lib/ws-server.ts`) and the `X-PrintStream-Web-Build` response header on every
 * `/api` response (`app.ts`). The browser compares it against the id baked into the
 * bundle it is actually running and reloads when they differ; the client half is
 * `apps/web/src/lib/webBuildId.ts` and `apps/web/src/lib/appStaleness.ts`.
 *
 * The value is read out of `build-id.json`, which the web build emits next to the
 * bundle (`apps/web/webBuildIdPlugin.ts`, its counterpart). Deliberately NOT
 * `getAppBuildInfo()`: that reports the API image's git revision, which answers a
 * different question and is wrong here in three separate ways. It is permission-gated
 * (the cloud image returns null to non-platform members, who are exactly the users this
 * needs to reach), it does not exist on a source run, and in a split topology the API
 * and the SPA can legitimately be different commits, so comparing against it would
 * report staleness that reloading could never fix. Reading the bundle's own id keeps the
 * comparison well-posed: the server describes the files it has on disk.
 *
 * Assumes the served directory does not change while the process runs, which holds for
 * every shipping topology (a deploy replaces the container, and a native in-place update
 * restarts the process). Revisit the memoization if a build is ever swapped underneath a
 * live server.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { env } from './env.js'

/** Emitted by `apps/web/webBuildIdPlugin.ts`. Renaming needs both sides changed together. */
const BUILD_ID_FILE = 'build-id.json'

let cachedWebBuildId: string | null | undefined

/**
 * The served bundle's build id, or null when there is nothing to report: no
 * `SERVE_WEB_DIR` (split topology, where something else serves the SPA), or a bundle
 * built before the plugin existed.
 *
 * Null is "unknown", never "stale": every consumer omits the value entirely rather than
 * sending a blank one, so a client can only ever be told it is behind by a server that
 * genuinely knows what it is serving.
 */
export function getServedWebBuildId(): string | null {
  if (cachedWebBuildId !== undefined) return cachedWebBuildId
  cachedWebBuildId = readWebBuildIdFrom(env.SERVE_WEB_DIR)
  // Serving a bundle but unable to identify it means every browser silently loses its
  // staleness check, which is invisible from the outside and is exactly the "shipped
  // inert" failure this feature exists to prevent. Warn once (the result is memoized), and
  // only when a directory IS configured: having none is the split topology, not a fault.
  if (env.SERVE_WEB_DIR && cachedWebBuildId === null) {
    console.warn(
      '[web-build-id] serving a web bundle with no readable build-id.json; clients will not auto-update',
      { webDir: env.SERVE_WEB_DIR }
    )
  }
  return cachedWebBuildId
}

/**
 * The pure core: read the build id out of a served directory, or null.
 *
 * Every failure is the same answer, because they all mean the same thing here. No
 * directory (split topology), no file (a bundle predating the build stamp), unparseable
 * or blank contents: none of them tell us what is being served, and reporting a guess
 * would make clients reload toward a build that may not exist.
 */
export function readWebBuildIdFrom(webDir: string | undefined): string | null {
  if (!webDir) return null
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(path.resolve(webDir), BUILD_ID_FILE), 'utf8')
    ) as { buildId?: unknown }
    if (typeof parsed.buildId !== 'string') return null
    return parsed.buildId.trim() || null
  } catch {
    return null
  }
}

/** Test seam: drop the memoized id so a test can restage the directory. */
export function resetServedWebBuildIdCache(): void {
  cachedWebBuildId = undefined
}
