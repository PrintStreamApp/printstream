/**
 * Cover thumbnails for calibration prints.
 *
 * A calibration 3MF is built from procedural geometry, and BambuStudio's CLI does not render a
 * useful plate preview for it, so jobs/history would show a blank cover. Rather than ship a 3D
 * renderer (the API/bridge have none), we draw a small, recognizable flat icon per calibration kind
 * with pngjs and embed it as the sliced output's plate thumbnail. Distinct per kind so a glance at
 * Jobs tells a pressure-advance tower from a flow-ratio plate.
 */
import { PNG } from 'pngjs'
import type { CalibrationKind } from '@printstream/shared'

const SIZE = 512
const SS = 2 // 2x supersample, box-downsampled, so polygon/rounded edges are smooth.
const HI = SIZE * SS

type RGB = readonly [number, number, number]
const BG_TOP: RGB = [15, 20, 28]
const BG_BOTTOM: RGB = [26, 33, 46]
const ACCENT: RGB = [55, 190, 183]
const ACCENT_DARK: RGB = [34, 132, 128]
const INK: RGB = [11, 15, 21]

/** A mutable RGBA canvas at supersampled resolution. */
class Canvas {
  readonly data = new Uint8ClampedArray(HI * HI * 4)

  set(x: number, y: number, color: RGB, alpha = 255): void {
    if (x < 0 || y < 0 || x >= HI || y >= HI) return
    const i = (y * HI + x) * 4
    const a = alpha / 255
    const inv = 1 - a
    this.data[i] = color[0] * a + (this.data[i] ?? 0) * inv
    this.data[i + 1] = color[1] * a + (this.data[i + 1] ?? 0) * inv
    this.data[i + 2] = color[2] * a + (this.data[i + 2] ?? 0) * inv
    this.data[i + 3] = 255
  }

  /**
   * Fill a rounded rectangle in supersampled pixels (radius 0 = plain rectangle). `color` may be a
   * per-pixel function so a single rounded silhouette can carry a two-tone/shaded interior.
   */
  roundedRect(x0: number, y0: number, x1: number, y1: number, radius: number, color: RGB | ((x: number, y: number) => RGB), alpha = 255): void {
    const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2))
    const colorAt = typeof color === 'function' ? color : () => color
    for (let y = Math.floor(y0); y < y1; y++) {
      for (let x = Math.floor(x0); x < x1; x++) {
        const dx = x < x0 + r ? x0 + r - x : x > x1 - r - 1 ? x - (x1 - r - 1) : 0
        const dy = y < y0 + r ? y0 + r - y : y > y1 - r - 1 ? y - (y1 - r - 1) : 0
        if (dx > 0 && dy > 0 && dx * dx + dy * dy > r * r) continue
        this.set(x, y, colorAt(x, y), alpha)
      }
    }
  }
}

/** px/coordinate helpers are authored at the SIZE grid then scaled to the supersampled canvas. */
function draw(kind: CalibrationKind): Canvas {
  const c = new Canvas()
  const s = (v: number) => Math.round(v * SS)

  // Vertical background gradient.
  for (let y = 0; y < HI; y++) {
    const t = y / (HI - 1)
    const bg: RGB = [
      BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t,
      BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t,
      BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t
    ]
    for (let x = 0; x < HI; x++) c.set(x, y, bg)
  }

  if (kind === 'pressureAdvance') {
    // A tall column with a rounded top, split-shaded for a lit-from-right look, banded across its
    // height (the K steps) with a seam line down the right side — a pressure-advance tower.
    const left = s(190)
    const right = s(322)
    const top = s(96)
    const bottom = s(430)
    const mid = s(256)
    // One rounded column, shaded darker on the left half so it reads as a lit 3D tower.
    c.roundedRect(left, top, right, bottom, s(30), (x) => (x < mid ? ACCENT_DARK : ACCENT))
    for (let band = 1; band <= 6; band++) {
      const y = top + Math.round(((bottom - top) * band) / 7)
      c.roundedRect(left, y, right, y + s(4), 0, INK, 150)
    }
    // Seam line just inside the right edge.
    c.roundedRect(right - s(16), top + s(14), right - s(10), bottom - s(8), 0, INK, 120)
  } else {
    // A 3x3 grid of tiles on a plate — a flow-ratio plate. A faint per-tile brightness ramp hints at
    // the range of flow values being compared.
    c.roundedRect(s(120), s(150), s(392), s(392), s(24), ACCENT_DARK, 90)
    const tile = s(66)
    const gap = s(20)
    const gridW = tile * 3 + gap * 2
    const originX = s(256) - gridW / 2
    const originY = s(271) - gridW / 2
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const idx = row * 3 + col
        const shade = 0.72 + (idx / 8) * 0.28
        const color: RGB = [ACCENT[0] * shade, ACCENT[1] * shade, ACCENT[2] * shade]
        const x = originX + col * (tile + gap)
        const y = originY + row * (tile + gap)
        c.roundedRect(x, y, x + tile, y + tile, s(10), color)
      }
    }
  }
  return c
}

/** Box-downsample the supersampled canvas to the final SIZE and encode a PNG buffer. */
function encode(canvas: Canvas): Buffer {
  const png = new PNG({ width: SIZE, height: SIZE })
  const n = SS * SS
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = (((y * SS + dy) * HI) + (x * SS + dx)) * 4
          r += canvas.data[i]!
          g += canvas.data[i + 1]!
          b += canvas.data[i + 2]!
        }
      }
      const o = (y * SIZE + x) * 4
      png.data[o] = Math.round(r / n)
      png.data[o + 1] = Math.round(g / n)
      png.data[o + 2] = Math.round(b / n)
      png.data[o + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

const cache = new Map<CalibrationKind, Buffer>()

/** A recognizable PNG cover for a calibration kind, rendered once and cached in memory. */
export function renderCalibrationCover(kind: CalibrationKind): Buffer {
  const cached = cache.get(kind)
  if (cached) return cached
  const png = encode(draw(kind))
  cache.set(kind, png)
  return png
}
