#!/usr/bin/env node
/**
 * Bundles the bridge for the slim, bridge-only Docker image (Dockerfile
 * `bridge` target, published as ghcr.io/printstreamapp/printstream-bridge):
 *
 *  - `dist/bridge-runner.cjs`  — the runtime entry (`src/index.ts`)
 *  - `dist/bridge-launcher.cjs` — the image entrypoint (`src/launcher-docker.ts`),
 *    which starts an activated signed app bundle from the releases dir (in-place
 *    self-update) and falls back to the image-baked runner. The launcher is the
 *    fixed point of the update scheme: it ships only with the image and must
 *    stay dependency-free.
 *
 * The bridge has a tiny dependency footprint — no Prisma, web, or API deps — so
 * esbuild-bundling its runtime lets the image ship single files on the base
 * image (which already carries the ffmpeg the camera relay needs) instead of
 * the full ~800 MB workspace node_modules the combined image copies. Mirrors
 * the esbuild settings of the standalone (SEA) build in
 * scripts/private/build-sea.mjs.
 *
 * The runner bundle is also the artifact the in-place self-update ships: the
 * (private) packaging step gzips + signs this exact file, so what CI publishes
 * is byte-identical to what a fresh image runs.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const bridgeRoot = path.resolve(scriptDir, '..')

const esbuild = await import('esbuild')

const sharedOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
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
}

const targets = [
  { entry: 'src/index.ts', outfile: 'dist/bridge-runner.cjs', label: 'bridge runner' },
  { entry: 'src/launcher-docker.ts', outfile: 'dist/bridge-launcher.cjs', label: 'bridge launcher' }
]

for (const target of targets) {
  const outfile = path.join(bridgeRoot, target.outfile)
  const result = await esbuild.build({
    ...sharedOptions,
    entryPoints: [path.join(bridgeRoot, target.entry)],
    outfile
  })
  if (result.errors.length > 0) {
    console.error(`esbuild bundling failed for ${target.label}.`)
    process.exit(1)
  }
  console.log(`Bundled ${target.label} -> ${path.relative(process.cwd(), outfile)}`)
}
