/**
 * The identity of the web bundle THIS TAB is running.
 *
 * Owns one fact: which build the browser actually loaded. Everything that decides
 * whether this client is stale (`appStaleness.ts`) compares that against the id the
 * server reports for the bundle it is currently serving, which arrives on the WS
 * hello frame and on every `/api` response header.
 *
 * The id is baked in at build time as a `<meta>` tag by `apps/web/webBuildIdPlugin.ts`
 * (its counterpart; the same value is written to `dist/build-id.json` for the server to
 * read). A meta tag rather than a Vite `define` on purpose: the id is a hash OF the
 * emitted bundle, and defining it into that same bundle would change the hash it
 * describes. `index.html` is written after the chunks are final, so it can carry an
 * honest content-addressed id; it is also the file that decides which chunks this tab
 * loads, so it is the correct thing to identify.
 *
 * Absent in dev and in any build predating the plugin, which reads as "unknown" and
 * makes staleness detection inert rather than wrong. An EMPTY tag is also unknown: a
 * blank id shipped as if it were real is how the native update channel sat dead for two
 * weeks (see `apps/server/scripts/build-sea.mjs`).
 */

/** Name of the `<meta>` tag carrying the build id. Shared with the build plugin. */
export const WEB_BUILD_ID_META_NAME = 'printstream:web-build'

let cachedBuildId: string | null | undefined

/**
 * The running bundle's build id, or null when this build carries none.
 *
 * Memoized: the tag is static for the life of the document, and this is read on every
 * API response.
 */
export function readLocalWebBuildId(): string | null {
  if (cachedBuildId !== undefined) return cachedBuildId
  if (typeof document === 'undefined') return null
  const tag = document.querySelector<HTMLMetaElement>(`meta[name="${WEB_BUILD_ID_META_NAME}"]`)
  cachedBuildId = tag?.content.trim() || null
  return cachedBuildId
}

/** Test seam: forget the memoized lookup so a test can restage the document. */
export function resetLocalWebBuildIdForTests(): void {
  cachedBuildId = undefined
}
