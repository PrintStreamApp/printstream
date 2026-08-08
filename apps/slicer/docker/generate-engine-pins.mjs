#!/usr/bin/env node
/**
 * Regenerate the per-platform download pins in `slicer-targets.mjs`.
 *
 * Each engine ships a Linux AppImage and a Windows portable zip, and every one
 * has to be recorded with a URL and a sha256 so an install verifies what it
 * downloaded. That is 14 artifacts and ~5 GB of fetching, which is not something
 * to do by hand: a mistyped digit fails an install with a checksum error that
 * says nothing about which character is wrong.
 *
 * The asset FILENAMES carry a build timestamp that cannot be derived from the
 * version (`Bambu_Studio_win-v02.07.01.62-20260616174358.zip`), so they are read
 * from the GitHub release rather than constructed — the same trap the
 * `slicer-targets.mjs` header warns about for `downloadUrl`.
 *
 * Prints a ready-to-paste `ENGINE_ASSETS` block. It does not edit the table
 * itself: a version bump should be a reviewed diff, not a silent rewrite.
 *
 * Usage: node apps/slicer/docker/generate-engine-pins.mjs [--only <tag>]
 */
import { createHash } from 'node:crypto'
import { slicerTargets } from './slicer-targets.mjs'

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null

/** The release tag a target's existing Linux URL was published under. */
function releaseTagOf(target) {
  const match = /\/download\/([^/]+)\//.exec(target.downloadUrl)
  if (!match) throw new Error(`Cannot read a release tag from ${target.id}'s downloadUrl`)
  return match[1]
}

async function releaseAssets(tag) {
  const response = await fetch(`https://api.github.com/repos/bambulab/BambuStudio/releases/tags/${tag}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'printstream-pins' }
  })
  if (!response.ok) throw new Error(`GitHub release ${tag}: ${response.status}`)
  const body = await response.json()
  return body.assets ?? []
}

/** Stream the asset and hash it without holding ~460 MB in memory. */
async function hashUrl(url) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status}): ${url}`)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of response.body) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hash.digest('hex'), bytes }
}

/**
 * Pick each platform's asset.
 *
 * **Linux keeps whatever `slicer-targets.mjs` already points at.** Releases ship
 * several AppImages differing only in Ubuntu base, and the base sets the glibc
 * floor — 2.6.0.51 is pinned to ubuntu-22.04, and silently "upgrading" it to
 * 24.04 while recording a checksum would change what every existing install runs
 * under cover of a pinning change. Recording a pin must not re-decide the
 * artifact.
 *
 * Windows has no existing pin to preserve, so it takes the portable zip — never
 * the installer .exe. The zip needs no elevation and no registry, and unpacks
 * with the yauzl already in the tree.
 */
function pickAssets(assets, target) {
  const existingName = target.downloadUrl.split('/').pop()
  const linux = assets.find((asset) => asset.name === existingName)
  if (!linux) throw new Error(`${target.id}: the pinned Linux asset ${existingName} is gone from its release`)
  return {
    'linux-x64': linux,
    'win32-x64': assets.find((asset) => /win.*\.zip$/i.test(asset.name)) ?? null
  }
}

const lines = ['export const ENGINE_ASSETS = {']
for (const target of slicerTargets) {
  const tag = releaseTagOf(target)
  if (only && only !== tag && only !== target.id) continue
  process.stderr.write(`${target.id} (${tag})\n`)
  const picked = pickAssets(await releaseAssets(tag), target)
  lines.push(`  '${target.id}': {`)
  for (const [platform, asset] of Object.entries(picked)) {
    if (!asset) {
      process.stderr.write(`  !! no ${platform} asset\n`)
      continue
    }
    process.stderr.write(`  ${platform}: hashing ${(asset.size / 1_000_000).toFixed(0)} MB…\n`)
    const { sha256, bytes } = await hashUrl(asset.browser_download_url)
    if (bytes !== asset.size) throw new Error(`${target.id} ${platform}: expected ${asset.size} bytes, got ${bytes}`)
    lines.push(`    '${platform}': {`)
    lines.push(`      url: '${asset.browser_download_url}',`)
    lines.push(`      sha256: '${sha256}',`)
    lines.push(`      bytes: ${bytes}`)
    lines.push('    },')
  }
  lines.push('  },')
}
lines.push('}')
process.stdout.write(`${lines.join('\n')}\n`)
