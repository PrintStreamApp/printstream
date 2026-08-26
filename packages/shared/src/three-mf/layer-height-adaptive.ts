/**
 * The three things that MAKE a variable layer-height profile: adaptive generation, smoothing, and
 * the brush edit. Ports of BambuStudio's `SlicingAdaptive.cpp` / `Slicing.cpp`, kept pure (they take
 * a triangle soup and numbers, never a mesh object) so they are testable without a renderer.
 *
 * The codec and the profile invariants live next door in `layer-height-profile.ts`.
 *
 * ## Ported deliberately, including the odd parts
 *
 * The goal is the curve BambuStudio produces, so its specific constants are kept: the slope metric
 * with its `1.44 * deviation * sqrt(sin/cos)` form and `/0.184` roughness cap
 * (`SlicingAdaptive.cpp:64`), the quality parameter's piecewise lerp around the nominal layer
 * height (`:103-124`), the 0.04 mm cap on how fast height may grow between layers
 * (`LAYER_HEIGHT_CHANGE_STEP`, `Slicing.cpp:26`), and the raised-cosine brush (`Slicing.cpp:544`).
 *
 * ## Ported by INTENT, where the original is provably wrong
 *
 * Two places where copying the code would copy a bug:
 *  - Smoothing's window gate multiplies the z distance by `layer_height` and compares against
 *    `radius * layer_height` (`Slicing.cpp:392-393`), so the factors cancel and the "radius in
 *    layers" it documents is really a radius in millimetres. We implement the millimetre band it
 *    actually performs, without the cancelling multiply.
 *  - BambuStudio runs the blur six times unconditionally because the gate that was meant to decide
 *    that is commented out (`Slicing.cpp:411-436`). Here the pass count is a parameter, defaulting
 *    to Studio's six so results match.
 */
import {
  clampLayerHeight,
  layerHeightAt,
  normalizeLayerHeightProfile,
  type LayerHeightBounds,
  type LayerHeightProfile
} from './layer-height-profile.js'

/** How fast a layer may grow over the one below it, mm (`Slicing.cpp:26`). */
/**
 * The smallest layer-height change BambuStudio treats as a step (`Slicing.cpp:26`). Exported
 * because it is also the natural quantum for DISPLAYING a profile: the editor's viewport overlay
 * buckets heights on it, so the zones a user sees are the steps the engine itself works in rather
 * than an invented display constant.
 */
export const LAYER_HEIGHT_CHANGE_STEP = 0.04

/** Control-point spacing the brush resamples onto, mm (`Slicing.cpp:507`). */
const PAINT_RESAMPLE_STEP = 0.1

export interface AdaptiveLayerHeightOptions {
  /** The object's printable height, mm. */
  objectHeight: number
  /** Extruder band the result must sit inside. */
  bounds: LayerHeightBounds
  /** The process layer height, the "nominal" the quality parameter pivots around. */
  nominalHeight: number
  /**
   * 0 = best quality (deviation = the min layer height), 0.5 = nominal, 1 = fastest
   * (deviation = the max). BambuStudio's slider default is 0.5 (`GLCanvas3D.hpp:251`).
   */
  quality: number
  /**
   * The machine's first-layer height. Pinned as the profile's first value, without which
   * BambuStudio discards the whole curve (`PrintObject.cpp:3341`).
   */
  firstLayerHeight?: number
}

/** One triangle's Z span and slope, all the adaptive pass needs from the mesh. */
interface FacetSlope {
  minZ: number
  maxZ: number
  /** |normal.z|: 1 for a horizontal facet, 0 for a vertical wall. */
  nCos: number
  /** Length of the normal's XY part. */
  nSin: number
}

/**
 * Reduce a world-space triangle soup (9 floats per triangle) to the per-facet slope data the
 * adaptive pass consumes, sorted by Z span exactly as `SlicingAdaptive::prepare` does.
 */
export function facetSlopesFromSoup(soup: Float32Array): FacetSlope[] {
  const facets: FacetSlope[] = []
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const ax = soup[t]!, ay = soup[t + 1]!, az = soup[t + 2]!
    const bx = soup[t + 3]!, by = soup[t + 4]!, bz = soup[t + 5]!
    const cx = soup[t + 6]!, cy = soup[t + 7]!, cz = soup[t + 8]!
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz)
    if (length <= 0) continue
    facets.push({
      minZ: Math.min(az, bz, cz),
      maxZ: Math.max(az, bz, cz),
      nCos: Math.abs(nz) / length,
      nSin: Math.hypot(nx, ny) / length
    })
  }
  facets.sort((a, b) => a.minZ - b.minZ || a.maxZ - b.maxZ)
  return facets
}

/**
 * The per-facet height limit: near-horizontal facets demand thin layers, vertical walls impose no
 * limit at all. Port of `SlicingAdaptive::layer_height_from_slope` (`SlicingAdaptive.cpp:52-68`).
 */
function heightFromSlope(facet: FacetSlope, maxSurfaceDeviation: number): number {
  const roughnessCap = maxSurfaceDeviation / 0.184
  if (facet.nCos <= 1e-5) return roughnessCap
  return Math.min(roughnessCap, 1.44 * maxSurfaceDeviation * Math.sqrt(facet.nSin / facet.nCos))
}

/**
 * How much surface deviation the quality parameter allows, pivoting on the nominal layer height
 * (`SlicingAdaptive.cpp:103-124`). Below 0.5 it interpolates toward the min layer height, above it
 * toward the max, so 0.5 reproduces ordinary uniform layering.
 */
function surfaceDeviationForQuality(quality: number, options: AdaptiveLayerHeightOptions): number {
  const q = Math.min(Math.max(quality, 0), 1)
  const { min, max } = options.bounds
  const mid = options.nominalHeight
  return q < 0.5 ? min + (mid - min) * (2 * q) : max + (mid - max) * (2 * (1 - q))
}

/**
 * Generate an adaptive profile from the object's geometry: thin layers where the surface is
 * shallow, thick where it is vertical. Port of `layer_height_profile_adaptive`
 * (`Slicing.cpp:239-329`).
 *
 * `soup` is OBJECT-space triangles (z=0 at the model's underside), matching the frame the profile
 * itself is stored in. Returns a normalized profile, or null when the object has no usable facets.
 */
export function adaptiveLayerHeightProfile(
  soup: Float32Array,
  options: AdaptiveLayerHeightOptions
): LayerHeightProfile | null {
  const facets = facetSlopesFromSoup(soup)
  if (facets.length === 0) return null
  const deviation = surfaceDeviationForQuality(options.quality, options)
  const { bounds, objectHeight } = options
  const profile: number[] = []

  let printZ = 0
  if (options.firstLayerHeight != null && options.firstLayerHeight > 0) {
    // A fixed first layer is pinned as its own flat span before the adaptive part starts.
    profile.push(0, options.firstLayerHeight, options.firstLayerHeight, options.firstLayerHeight)
    printZ = options.firstLayerHeight
  }

  let guard = 0
  while (printZ < objectHeight && guard++ < 100_000) {
    let height = bounds.max
    // Facets the candidate layer would cut through set the limit.
    for (const facet of facets) {
      if (facet.maxZ <= printZ) continue
      if (facet.minZ > printZ + height) break
      if (facet.minZ <= printZ && facet.maxZ >= printZ) {
        height = Math.min(height, heightFromSlope(facet, deviation))
      }
    }
    height = clampLayerHeight(height, bounds)
    // Never grow faster than Studio allows, or the surface shows a visible step.
    const previous = profile.length >= 2 ? profile[profile.length - 1]! : height
    if (height > previous && height - previous > LAYER_HEIGHT_CHANGE_STEP) {
      height = previous + LAYER_HEIGHT_CHANGE_STEP
    }
    printZ = Math.min(printZ + height, objectHeight)
    profile.push(printZ, height)
  }
  return normalizeLayerHeightProfile(profile, objectHeight, bounds, options.firstLayerHeight)
}

export interface SmoothProfileOptions {
  bounds: LayerHeightBounds
  /** Window radius in MILLIMETRES (see the module header on Studio's mislabelled gate). 1..10. */
  radius: number
  /** Never let a layer get thicker than it already was. Studio's "Keep min" checkbox. */
  keepMin: boolean
  /** Blur passes. Studio does 6 unconditionally; kept as a parameter. */
  passes?: number
  /** The machine's first-layer height, re-pinned after smoothing. */
  firstLayerHeight?: number
}

/**
 * Smooth a profile with the biased Gaussian BambuStudio uses (`Slicing.cpp:332-439`).
 *
 * The bias weights each sample by `sqrt(|max - h| / (max - min))`, which pulls the smoothed curve
 * toward the THIN end of the band: Studio's own comment claims the opposite direction, but the
 * expression is what it ships, and the point here is to reproduce its output.
 */
export function smoothLayerHeightProfile(
  profile: readonly number[],
  objectHeight: number,
  options: SmoothProfileOptions
): LayerHeightProfile | null {
  const radius = Math.min(Math.max(Math.round(options.radius), 1), 10)
  const passes = options.passes ?? 6
  const { min, max } = options.bounds
  const deltaH = max - min
  const sigma = 0.3 * (radius - 1) + 0.8

  let current = [...profile]
  if (current.length < 6) return normalizeLayerHeightProfile(current, objectHeight, options.bounds, options.firstLayerHeight)

  for (let pass = 0; pass < passes; pass += 1) {
    const next = [...current]
    for (let i = 0; i + 1 < current.length; i += 2) {
      const zi = current[i]!
      let weightTotal = 0
      let heightTotal = 0
      for (let j = 0; j + 1 < current.length; j += 2) {
        // The millimetre band Studio's cancelling multiply actually performs.
        const dz = Math.abs(zi - current[j]!)
        if (dz > radius) continue
        const hj = current[j + 1]!
        const gaussian = Math.exp(-(dz * dz) / (2 * sigma * sigma))
        const bias = deltaH > 0 ? Math.sqrt(Math.abs(max - hj) / deltaH) : 1
        const weight = gaussian * bias
        weightTotal += weight
        heightTotal += hj * weight
      }
      const smoothed = weightTotal === 0 ? current[i + 1]! : heightTotal / weightTotal
      const clamped = clampLayerHeight(smoothed, options.bounds)
      next[i + 1] = options.keepMin ? Math.min(clamped, current[i + 1]!) : clamped
    }
    current = next
  }
  return normalizeLayerHeightProfile(current, objectHeight, options.bounds, options.firstLayerHeight)
}

/** What a brush stroke does to the layers under it. Mirrors `LayerHeightEditActionType`. */
export type LayerHeightPaintAction = 'addDetail' | 'removeDetail' | 'resetToBase' | 'smooth'

export interface PaintProfileOptions {
  objectHeight: number
  bounds: LayerHeightBounds
  /** The process layer height, which `resetToBase` pulls toward. */
  nominalHeight: number
  /** Brush diameter along Z, mm. Studio wheel-adjusts this within 1.5..10. */
  bandWidth: number
  /** Thickness delta per stroke event, mm. Studio uses a fixed 0.005. */
  strength: number
  /** The machine's first-layer height, re-pinned after the stroke. */
  firstLayerHeight?: number
}

/**
 * Apply one brush stroke centred at `z`, the way Studio's thickness-bar painting does
 * (`adjust_layer_height_profile`, `Slicing.cpp:441-622`).
 *
 * The band under the brush is RESAMPLED onto a fixed 0.1 mm grid and spliced back between the
 * untouched head and tail, which is why a painted profile carries hundreds of control points while
 * a flat one carries three. The brush profile is a raised cosine, so a stroke feathers out at its
 * edges instead of leaving a step.
 */
export function paintLayerHeightProfile(
  profile: readonly number[],
  z: number,
  action: LayerHeightPaintAction,
  options: PaintProfileOptions
): LayerHeightProfile | null {
  const { objectHeight, bounds, bandWidth } = options
  const half = Math.max(bandWidth, PAINT_RESAMPLE_STEP) / 2
  const lo = Math.max(0, z - half)
  const hi = Math.min(objectHeight, z + half)
  if (hi <= lo) return normalizeLayerHeightProfile([...profile], objectHeight, bounds, options.firstLayerHeight)

  const head: number[] = []
  const tail: number[] = []
  for (let i = 0; i + 1 < profile.length; i += 2) {
    if (profile[i]! < lo) head.push(profile[i]!, profile[i + 1]!)
    else if (profile[i]! > hi) tail.push(profile[i]!, profile[i + 1]!)
  }

  const band: number[] = []
  for (let zz = lo; zz <= hi + 1e-9; zz += PAINT_RESAMPLE_STEP) {
    const at = Math.min(zz, hi)
    const existing = layerHeightAt(profile, at)
    // Raised cosine: full strength at the centre, zero at the brush edge.
    const distance = Math.abs(at - z)
    const weight = distance < half ? 0.5 + 0.5 * Math.cos((Math.PI * distance) / half) : 0
    let height = existing
    if (action === 'addDetail') height = existing - options.strength * weight
    else if (action === 'removeDetail') height = existing + options.strength * weight
    else if (action === 'resetToBase') height = existing + (options.nominalHeight - existing) * weight
    else if (action === 'smooth') {
      const neighbourhood = (layerHeightAt(profile, Math.max(0, at - PAINT_RESAMPLE_STEP))
        + existing
        + layerHeightAt(profile, Math.min(objectHeight, at + PAINT_RESAMPLE_STEP))) / 3
      height = existing + (neighbourhood - existing) * weight
    }
    band.push(at, clampLayerHeight(height, bounds))
    if (at >= hi) break
  }

  return normalizeLayerHeightProfile([...head, ...band, ...tail], objectHeight, bounds, options.firstLayerHeight)
}
