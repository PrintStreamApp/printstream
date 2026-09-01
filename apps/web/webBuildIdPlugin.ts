/**
 * Stamps each production build with an identity of its own (wired in `vite.config.ts`).
 *
 * The browser bundle was the only artifact in the repo that could not answer "which
 * build am I". The API image, the native binary, and the bridge all carry a
 * content-addressed fingerprint; the tab carried nothing, so the sole way a client
 * could learn it was behind a deploy was the service worker noticing on its own. When
 * that check does not run, and the worker serves navigations out of its precache, the
 * client is pinned to a build that reloading cannot shift. This closes that by writing
 * the same id to two places:
 *
 *  - a `<meta>` tag in `index.html`, read at runtime by `src/lib/webBuildId.ts` (its
 *    counterpart) to learn what THIS TAB is running;
 *  - `build-id.json` in the output directory, read at boot by the API
 *    (`apps/api/src/lib/web-build-id.ts`) to report what it is currently SERVING.
 *
 * Both come from one computation, so the two can never disagree about a single build.
 * That is the property the whole scheme rests on: the server describes the bundle it
 * has on disk rather than its own image revision, so a client comparing the two is
 * asking a question that is always well-posed, even when the API and the SPA were
 * deployed from different commits.
 *
 * The id is a hash of the emitted output filenames, which Vite has already
 * content-hashed. So it is derived, not stamped: two builds of identical sources
 * produce the same id and clients are not reloaded for a redeploy that changed
 * nothing. A timestamp or a git sha would both have bounced on every rebuild.
 *
 * WHAT IT COVERS, measured against real builds rather than assumed:
 *  - a change to any bundled module, JS or CSS, moves the id (their emitted names are
 *    content hashes, and CSS assets are present by the time this runs);
 *  - a change to a `public/` file (icons, `robots.txt`, `push-handler.js`) does NOT,
 *    because those are copied verbatim and never enter the bundle;
 *  - a change to `index.html` alone does NOT, since HTML is excluded below.
 *
 * The last two are a deliberate accepted gap, not an oversight. Both still change the
 * generated `sw.js` precache manifest, so the service worker notices them and reaches
 * the same reload through `appStaleness.ts`. They degrade to the older, slower detector
 * rather than going unnoticed, and covering them here would mean hashing a file that
 * this plugin is itself modifying.
 *
 * Production only. A dev server emits no tag, and `readLocalWebBuildId()` reads that
 * as unknown, which makes staleness detection inert rather than wrong.
 */
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Plugin } from 'vite'
import { WEB_BUILD_ID_META_NAME } from './src/lib/webBuildId.ts'

/** Written next to the bundle for the API to read. Do not rename without updating `web-build-id.ts`. */
export const WEB_BUILD_ID_FILE = 'build-id.json'

const BUILD_ID_LENGTH = 16

/**
 * Hash the bundle's own content-hashed filenames into one short id.
 *
 * HTML is excluded because it is the file being stamped: it is emitted last, is not
 * content-hashed, and including it would make the id depend on when in the emit order
 * this ran. Everything else that reaches the browser has its hash in its name already,
 * so the filename list is a faithful stand-in for the bytes.
 */
export function computeWebBuildId(fileNames: readonly string[]): string {
  const hashed = fileNames.filter((name) => !name.endsWith('.html')).sort()
  // An empty list still hashes, to the SAME constant on every build, which would ship a
  // plausible-looking id that never changes and a staleness check that silently never
  // fires. That is the failure this whole feature exists to prevent, so refuse to emit
  // one. Reachable if `ctx.bundle` is ever absent, or if a future Vite emits chunks after
  // the HTML transform.
  if (hashed.length === 0) {
    throw new Error('printstream:web-build-id found no emitted assets to derive an id from')
  }
  return createHash('sha256').update(hashed.join('\n')).digest('hex').slice(0, BUILD_ID_LENGTH)
}

export function webBuildIdPlugin(): Plugin {
  // Computed once while transforming `index.html` and reused when writing the JSON, so
  // the two artifacts are the same string by construction rather than by both
  // recomputing over a bundle that may have grown between the hooks.
  let buildId: string | null = null

  return {
    name: 'printstream:web-build-id',
    apply: 'build',
    transformIndexHtml: {
      // `post`, so every chunk and asset has its final content-hashed name by the time
      // the id is derived from them.
      order: 'post',
      handler(html, ctx) {
        buildId ??= computeWebBuildId(Object.keys(ctx.bundle ?? {}))
        return {
          html,
          tags: [{
            tag: 'meta',
            attrs: { name: WEB_BUILD_ID_META_NAME, content: buildId },
            injectTo: 'head-prepend'
          }]
        }
      }
    },
    async writeBundle(options) {
      // `transformIndexHtml` always runs first (generateBundle precedes writeBundle), so
      // a missing id means the HTML entry vanished from the build. Fail loudly rather
      // than shipping a bundle whose staleness check is silently dead, which is exactly
      // how the native update channel shipped inert for two weeks.
      if (!buildId) throw new Error('printstream:web-build-id produced no id (no HTML entry was transformed)')
      const outDir = options.dir
      if (!outDir) throw new Error('printstream:web-build-id could not resolve the output directory')
      await writeFile(
        path.join(outDir, WEB_BUILD_ID_FILE),
        `${JSON.stringify({ buildId }, null, 2)}\n`,
        'utf8'
      )
    }
  }
}
