#!/usr/bin/env node
/**
 * Bundles the bridge runtime entry (`src/index.ts`) into a single CJS file for
 * the slim, bridge-only Docker image (Dockerfile `bridge` target, published as
 * ghcr.io/printstreamapp/printstream-bridge).
 *
 * The bridge has a tiny dependency footprint — no Prisma, web, or API deps — so
 * esbuild-bundling its runtime lets the image ship one file on the base image
 * (which already carries the ffmpeg the camera relay needs) instead of the full
 * ~800 MB workspace node_modules the combined image copies. Mirrors the esbuild
 * settings of the standalone (SEA) build in scripts/private/build-sea.mjs.
 *
 * The bridge image has no in-place self-update: it updates by image pull, so it
 * bundles the runtime (`index.ts`) directly.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const bridgeRoot = path.resolve(scriptDir, '..')
const outfile = path.join(bridgeRoot, 'dist/bridge-runner.cjs')

const esbuild = await import('esbuild')
const result = await esbuild.build({
  entryPoints: [path.join(bridgeRoot, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  // Optional native ws accelerators; ws falls back to its JS implementation when
  // the require fails, so they need not be present in the image.
  external: ['bufferutil', 'utf-8-validate'],
  // env.ts reads import.meta.url; the CJS bundle has no ESM meta, so shim it from
  // __filename the same way the SEA build does.
  define: {
    'import.meta.url': '__bridgeImportMetaUrl'
  },
  banner: {
    js: "var __bridgeImportMetaUrl = require('node:url').pathToFileURL(__filename).href;"
  }
})

if (result.errors.length > 0) {
  console.error('esbuild bundling failed.')
  process.exit(1)
}

console.log(`Bundled bridge runner -> ${path.relative(process.cwd(), outfile)}`)
