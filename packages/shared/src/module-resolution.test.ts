import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * Every relative import in this package must name a file extension.
 *
 * This package is `"type": "module"` and builds with `moduleResolution: "Bundler"`, which lets
 * TypeScript ACCEPT `from './thing'` and emit it verbatim. Vite resolves that happily, so the web
 * app and every test pass -- but Node's ESM loader requires the extension, so the API crashes on
 * import with `ERR_MODULE_NOT_FOUND` naming a file that is sitting right there in `dist/`.
 *
 * That is a uniquely bad failure shape: typecheck is green, the whole test suite is green, and the
 * first thing that notices is the API container refusing to boot after a deploy. It reached staging
 * exactly once, with three separate offending edges (`./xml-write`, `./scene-parser`,
 * `./layer-height-profile`) that had accumulated across several commits because nothing looks at
 * this. Hence a test rather than a convention.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
}

test('every relative import names an extension, so Node ESM can resolve it', () => {
  const offenders: string[] = []
  for (const file of walk(SRC)) {
    // This file's own docs quote the offending form, and the scan reads text rather than parsing.
    if (file.endsWith('module-resolution.test.ts')) continue
    const source = readFileSync(file, 'utf8')
    // `from '...'` covers static imports, re-exports, and `export ... from`.
    for (const match of source.matchAll(/from '(\.\.?\/[^']*)'/g)) {
      const specifier = match[1]!
      if (!/\.(js|json)$/.test(specifier)) {
        offenders.push(`${file.slice(SRC.length)}: ${specifier}`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    `Relative imports must end in .js (the EMITTED name), or Node's ESM loader cannot resolve them:\n${offenders.join('\n')}`)
})
