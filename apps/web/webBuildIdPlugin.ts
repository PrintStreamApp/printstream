/**
 * Identifies the complete web build before stamping its HTML.
 *
 * The browser reads the stamp and update checks read build-id.json. Hashing the
 * emitted bytes (including unstamped HTML and the manifest) plus public assets
 * makes HTML-only and icon-only releases visible without worker-triggered reloads.
 * Worker activation updates offline caches; it is not evidence of a stale page.
 */
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Plugin } from 'vite'
import { WEB_BUILD_ID_META_NAME } from './src/lib/webBuildId.ts'

export const WEB_BUILD_ID_FILE = 'build-id.json'

export interface WebBuildFile {
  fileName: string
  source: string | Uint8Array
}

/** Hash file names and bytes deterministically, independent of enumeration order. */
export function computeWebBuildId(files: readonly WebBuildFile[]): string {
  if (files.length === 0) {
    throw new Error('web-build-id found no emitted assets to derive an id from')
  }
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.fileName.localeCompare(b.fileName, 'en'))) {
    const bytes = Buffer.from(file.source)
    // Length-prefix each field so names and contents cannot blur file boundaries.
    hash.update(`${Buffer.byteLength(file.fileName)}:${file.fileName}${bytes.length}:`)
    hash.update(bytes)
  }
  return hash.digest('hex').slice(0, 16)
}

/** Public files bypass the bundler, but belong to the same loaded app identity. */
async function readPublicFiles(directory: string, prefix = ''): Promise<WebBuildFile[]> {
  const files: WebBuildFile[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fileName = `${prefix}${entry.name}`
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await readPublicFiles(absolute, `${fileName}/`))
    } else {
      files.push({ fileName, source: await readFile(absolute) })
    }
  }
  return files
}

/** Stamp after Vite emits HTML, before Workbox builds its precache in closeBundle. */
export function webBuildIdPlugin(): Plugin {
  let publicDir: string | false = false
  return {
    name: 'web-build-id',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const html = bundle['index.html']
        if (!html || html.type !== 'asset') {
          throw new Error('web-build-id requires an index.html entry')
        }
        const files = new Map<string, WebBuildFile>()
        if (publicDir) {
          for (const file of await readPublicFiles(publicDir)) files.set(file.fileName, file)
        }
        for (const output of Object.values(bundle)) {
          files.set(output.fileName, {
            fileName: output.fileName,
            source: output.type === 'chunk' ? output.code : output.source
          })
        }
        const buildId = computeWebBuildId([...files.values()])
        const source = Buffer.from(html.source).toString('utf8')
        if (!source.includes('<head>')) throw new Error('web-build-id requires an HTML head')
        html.source = source.replace('<head>', `<head>\n    <meta name="${WEB_BUILD_ID_META_NAME}" content="${buildId}">`)
        this.emitFile({
          type: 'asset',
          fileName: WEB_BUILD_ID_FILE,
          source: `${JSON.stringify({ buildId })}\n`
        })
      }
    }
  }
}
