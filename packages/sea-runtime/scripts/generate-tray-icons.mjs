#!/usr/bin/env node
/**
 * Renders the tray and Windows app icons from the brand master (`assets/brand/icon.svg`) into
 * `src/tray/icon-data.generated.ts`, which `src/tray/icons.ts` embeds.
 *
 * One drawing for the tray, the standalone executables and the desktop app's `.ico`: this is the
 * deliberate exception to generating Windows icons with devkit-icons (app-standards ASSET-3), which
 * would give the app icon a source the tray does not share. It follows ASSET-5's frame list.
 *
 * The ICO keeps the format GDI+ accepts (`new Icon()` rejects some encoders' output, which once made
 * the brand icon silently fall back to a generic one): 32bpp BGRA bitmaps, bottom-up, each with the
 * 1bpp AND mask an entry requires. The 256 px frame is PNG, as Windows expects for that size; a
 * bitmap there would add a quarter of a megabyte to every executable.
 *
 * Usage: node packages/sea-runtime/scripts/generate-tray-icons.mjs [--check]
 *   --check fails when the committed module or the desktop app's `.ico` differs from what the
 *   master renders (for validate).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const masterPath = path.join(repoRoot, 'assets/brand/icon.svg')
const outputPath = path.join(repoRoot, 'packages/sea-runtime/src/tray/icon-data.generated.ts')
/**
 * The desktop app's tracked copy of the ICO (`apps/desktop/prepare-icons.mjs` writes the same bytes
 * at build time). The desktop app is closed source, so the public snapshot has no such folder and
 * this copy is skipped there.
 */
const desktopIcoPath = path.join(repoRoot, 'apps/desktop/assets/app.ico')
const hasDesktopApp = existsSync(path.dirname(desktopIcoPath))

/** ASSET-5's Windows frame list. */
const ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256]
/** Frames at or above this size are stored as PNG. */
const PNG_FRAME_MIN = 256
/** The Linux tray icon. */
const TRAY_PNG_SIZE = 32

/** Renders the master as a square PNG of `size` pixels, transparent around the art. */
function renderPng(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng()
}

/**
 * Renders the master as straight-alpha RGBA pixels of `size` x `size`. resvg hands back premultiplied
 * pixels; an ICO bitmap wants straight alpha, or every soft edge comes out dark.
 */
function renderRgba(svg, size) {
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render()
  if (image.width !== size || image.height !== size) throw new Error(`master rendered ${image.width}x${image.height}, expected ${size}x${size}`)
  const pixels = Buffer.from(image.pixels)
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]
    if (alpha === 0 || alpha === 255) continue
    for (let channel = 0; channel < 3; channel++) {
      pixels[i + channel] = Math.min(255, Math.round((pixels[i + channel] * 255) / alpha))
    }
  }
  return pixels
}

/** One ICO bitmap entry: BITMAPINFOHEADER, bottom-up BGRA pixels, then the 1bpp AND mask. */
function bitmapFrame(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // header size
  header.writeInt32LE(size, 4) // width
  header.writeInt32LE(size * 2, 8) // height: colour plus mask
  header.writeUInt16LE(1, 12) // planes
  header.writeUInt16LE(32, 14) // bits per pixel
  header.writeUInt32LE(0, 16) // BI_RGB

  const pixels = Buffer.alloc(size * size * 4)
  // The AND mask is 1bpp with each row padded to 32 bits; a set bit means transparent.
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y++) {
    const sourceRow = size - 1 - y // bottom-up
    for (let x = 0; x < size; x++) {
      const from = (sourceRow * size + x) * 4
      const to = (y * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
      if (rgba[from + 3] === 0) mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([header, pixels, mask])
}

/** Assembles the ICO directory and its frames. */
function buildIco(svg) {
  const frames = ICO_SIZES.map((size) => ({
    size,
    data: size >= PNG_FRAME_MIN ? renderPng(svg, size) : bitmapFrame(renderRgba(svg, size), size)
  }))
  const directory = Buffer.alloc(6 + frames.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2) // icon
  directory.writeUInt16LE(frames.length, 4)
  let offset = directory.length
  frames.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16
    directory.writeUInt8(size >= 256 ? 0 : size, entry) // 0 means 256
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    directory.writeUInt8(0, entry + 2) // no palette
    directory.writeUInt8(0, entry + 3)
    directory.writeUInt16LE(1, entry + 4) // planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([directory, ...frames.map((frame) => frame.data)])
}

/** The generated module's text, for an ICO already built. */
function moduleSource(svg, icoBytes) {
  const png = renderPng(svg, TRAY_PNG_SIZE).toString('base64')
  const ico = icoBytes.toString('base64')
  return `// Generated by packages/sea-runtime/scripts/generate-tray-icons.mjs from assets/brand/icon.svg.
// Do not edit: change the master and rerun the script. \`--check\` in validate fails when this drifts.

/** The Linux tray icon, ${TRAY_PNG_SIZE} px PNG. */
export const TRAY_ICON_PNG_BASE64 =
  '${png}'

/** The Windows tray, executable and desktop app icon: frames at ${ICO_SIZES.join(', ')} px. */
export const TRAY_ICON_ICO_BASE64 =
  '${ico}'
`
}

const svg = readFileSync(masterPath, 'utf8')
const ico = buildIco(svg)
const source = moduleSource(svg, ico)
if (process.argv.includes('--check')) {
  const stale = []
  if (readFileSync(outputPath, 'utf8') !== source) stale.push(path.relative(repoRoot, outputPath))
  if (hasDesktopApp && !readFileSync(desktopIcoPath).equals(ico)) stale.push(path.relative(repoRoot, desktopIcoPath))
  if (stale.length) {
    console.error(`Out of date with assets/brand/icon.svg: ${stale.join(', ')}. Run node packages/sea-runtime/scripts/generate-tray-icons.mjs`)
    process.exit(1)
  }
  console.log('Tray and desktop icons match assets/brand/icon.svg.')
} else {
  writeFileSync(outputPath, source)
  if (hasDesktopApp) writeFileSync(desktopIcoPath, ico)
  const written = [outputPath, ...(hasDesktopApp ? [desktopIcoPath] : [])].map((file) => path.relative(repoRoot, file))
  console.log(`Wrote ${written.join(' and ')} (${ICO_SIZES.length} ICO frames).`)
}
