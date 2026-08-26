/**
 * BambuStudio variable layer height: `Metadata/layer_heights_profile.txt`.
 *
 * Owns the codec and the invariants for a per-object layer-height PROFILE — the free-form curve
 * that decides how thick each layer is up the model, as opposed to the discrete bands in
 * `layer-config-ranges.ts`.
 *
 * ## The shape
 *
 * A profile is a flat array of alternating `z, height` pairs in OBJECT space (z=0 at the model's
 * underside, raft excluded), and consumers LINEARLY INTERPOLATE height between control points
 * rather than treating them as steps (`Slicing.cpp:757`). Invariants the engine asserts
 * (`Slicing.cpp:614-621`) and re-checks before slicing (`PrintObject.cpp:3320-3338`): even length,
 * `z[0] === 0`, z non-decreasing, the LAST z equal to the object's height, every height inside the
 * extruder's min/max band, and the FIRST height exactly equal to the machine's first-layer height.
 *
 * That last one is the cruellest: `PrintObject.cpp:3341` compares `profile[1]` to
 * `first_object_layer_height` with `!=` on doubles and, on any difference, throws the whole profile
 * away and silently reverts the object to uniform layering. It cost a real slice here — an adaptive
 * curve starting at 0.28 against a 0.2 first layer produced 177 identical 0.200 mm layers — so
 * {@link normalizeLayerHeightProfile} pins it rather than trusting callers to remember.
 *
 * ## The one interop trap
 *
 * BambuStudio's writer emits a profile at `size() >= 4` but its reader REJECTS one at
 * `size() <= 4` (`bbs_3mf.cpp:7612` vs `:2940`). A two-pair profile therefore round-trips to
 * nothing, logged only as "Found invalid layer heights profile". So anything we author carries at
 * least {@link MIN_PROFILE_PAIRS} pairs, padding a flat curve with a midpoint rather than emitting
 * the mathematically sufficient two.
 *
 * ## Precedence, which matters now that height ranges exist
 *
 * The profile WINS. `PrintObject.cpp:3340` only falls back to `layer_height_profile_from_ranges`
 * when the profile is absent or fails validation, so an object carrying both gets its ranges'
 * layer heights ignored (their other setting overrides still apply). Surfaces that offer both must
 * say so; silently letting two features fight is the failure mode here.
 *
 * Parsing is deliberately tolerant where BambuStudio's is not: its reader uses locale-dependent
 * `atof` with no error checking, so a malformed number becomes 0 and a profile silently collapses
 * the object onto the bed. A line we cannot read is skipped instead.
 */
import { parseRootModelObjectIdOrder } from './scene-parser.js'

/** The archive entry a profile lives in (`BBS_LAYER_HEIGHTS_PROFILE_FILE`, `bbs_3mf.cpp:175`). */
export const LAYER_HEIGHTS_PROFILE_ENTRY = 'Metadata/layer_heights_profile.txt'

/**
 * Fewest `z,height` pairs we will write. Three, not the mathematically sufficient two, because
 * BambuStudio's reader rejects a four-VALUE profile outright (see the module header).
 */
export const MIN_PROFILE_PAIRS = 3

/** Engine floor for any layer height, mm (`MIN_LAYER_HEIGHT`, `Slicing.cpp:24`). */
export const ENGINE_MIN_LAYER_HEIGHT = 0.01

/**
 * A layer-height profile: alternating z and height values, mm, object space.
 * Always even-length; see the module header for the full invariant set.
 */
export type LayerHeightProfile = number[]

/** The extruder band a profile's heights must sit inside. */
export interface LayerHeightBounds {
  min: number
  max: number
}

/** Height at `z`, linearly interpolated between control points (`Slicing.cpp:757`). */
export function layerHeightAt(profile: readonly number[], z: number): number {
  if (profile.length < 2) return 0
  if (z <= profile[0]!) return profile[1]!
  for (let i = 0; i + 3 < profile.length; i += 2) {
    const z0 = profile[i]!, h0 = profile[i + 1]!, z1 = profile[i + 2]!, h1 = profile[i + 3]!
    if (z <= z1) {
      if (z1 - z0 <= 0) return h1
      const t = (z - z0) / (z1 - z0)
      return h0 + (h1 - h0) * t
    }
  }
  return profile[profile.length - 1]!
}

/**
 * A flat profile at one height, in the shape the engine expects: anchored at z=0, ending at the
 * object's top, and padded to {@link MIN_PROFILE_PAIRS} so BambuStudio's reader accepts it.
 */
export function flatLayerHeightProfile(
  objectHeight: number,
  height: number,
  firstLayerHeight?: number
): LayerHeightProfile {
  const top = Math.max(objectHeight, ENGINE_MIN_LAYER_HEIGHT)
  const first = firstLayerHeight != null && firstLayerHeight > 0 ? firstLayerHeight : height
  return [0, first, Math.min(first, top), first, top, height]
}

/**
 * Force a profile into the shape the engine will accept, or return null when it cannot be saved.
 *
 * This is the ONE place the invariants are applied, because BambuStudio does not repair a profile
 * it dislikes — it DISCARDS it (`PrintObject.cpp:3327-3338` throws the whole thing away for a
 * single out-of-band height) and silently falls back to the ranges. Clamping here is what stops a
 * nozzle change quietly erasing a user's curve.
 */
export function normalizeLayerHeightProfile(
  profile: readonly number[],
  objectHeight: number,
  bounds: LayerHeightBounds,
  /**
   * The machine's first-layer height. When given, the profile is pinned to start with it, which is
   * what stops BambuStudio discarding the whole curve (see the module header). Omit only when the
   * caller genuinely has no first layer to honour.
   */
  firstLayerHeight?: number
): LayerHeightProfile | null {
  if (!Number.isFinite(objectHeight) || objectHeight <= 0) return null
  const pairs: Array<[number, number]> = []
  for (let i = 0; i + 1 < profile.length; i += 2) {
    const z = profile[i]!
    const h = profile[i + 1]!
    if (!Number.isFinite(z) || !Number.isFinite(h)) continue
    pairs.push([Math.max(0, Math.min(z, objectHeight)), clampLayerHeight(h, bounds)])
  }
  if (pairs.length === 0) return null
  pairs.sort((a, b) => a[0] - b[0])

  // Anchor at the base and at the top: the engine rejects a profile that does not span the object.
  if (pairs[0]![0] > 0) pairs.unshift([0, pairs[0]![1]])
  else pairs[0]![0] = 0
  const last = pairs[pairs.length - 1]!
  if (last[0] < objectHeight) pairs.push([objectHeight, last[1]])
  else last[0] = objectHeight

  // Pin the first layer. BambuStudio compares this one value with `!=` and discards the entire
  // profile on a mismatch, so it is set exactly rather than clamped toward.
  if (firstLayerHeight != null && firstLayerHeight > 0) {
    pairs[0]![1] = firstLayerHeight
    // Studio's own generators follow the anchor with a flat span at the same height when the first
    // layer is fixed, so the adaptive part starts above it rather than interpolating out of it.
    const fixedTop = Math.min(firstLayerHeight, objectHeight)
    if (pairs.length > 1 && pairs[1]![0] > fixedTop) pairs.splice(1, 0, [fixedTop, firstLayerHeight])
  }

  // Pad a too-short profile at its midpoint rather than emitting one Studio would reject.
  while (pairs.length < MIN_PROFILE_PAIRS) {
    const midZ = (pairs[0]![0] + pairs[pairs.length - 1]![0]) / 2
    pairs.splice(1, 0, [midZ, layerHeightAt(pairs.flat(), midZ)])
  }
  return pairs.flat()
}

/** Clamp one height into the extruder band, never below the engine's own floor. */
export function clampLayerHeight(height: number, bounds: LayerHeightBounds): number {
  const min = Math.max(ENGINE_MIN_LAYER_HEIGHT, bounds.min)
  const max = Math.max(min, bounds.max)
  return Math.min(Math.max(height, min), max)
}

/** True when the profile is a constant height, i.e. nothing the user would call "variable". */
export function isFlatLayerHeightProfile(profile: readonly number[], tolerance = 1e-6): boolean {
  if (profile.length < 4) return true
  const first = profile[1]!
  for (let i = 3; i < profile.length; i += 2) {
    if (Math.abs(profile[i]! - first) > tolerance) return false
  }
  return true
}

/**
 * Parse `Metadata/layer_heights_profile.txt` into profiles keyed by ROOT 3MF object id.
 *
 * `rootModelXml` supplies the ordinal order the file is written against. A line whose numbers do
 * not parse, or whose profile is odd-length or too short, is skipped rather than zero-filled the
 * way BambuStudio's `atof` would.
 */
export function parseLayerHeightProfiles(
  text: string | null,
  rootModelXml: string
): Map<number, LayerHeightProfile> {
  const out = new Map<number, LayerHeightProfile>()
  if (!text) return out
  const orderedObjectIds = parseRootModelObjectIdOrder(rootModelXml)
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^object_id=(\d+)\|(.*)$/.exec(line)
    if (!match) continue
    const ordinal = Number.parseInt(match[1] ?? '', 10)
    if (!Number.isInteger(ordinal) || ordinal <= 0) continue
    const objectId = orderedObjectIds[ordinal - 1]
    if (!objectId) continue
    const values = (match[2] ?? '').split(';').map((value) => Number.parseFloat(value.trim()))
    if (values.length % 2 !== 0 || values.length < MIN_PROFILE_PAIRS * 2) continue
    if (values.some((value) => !Number.isFinite(value))) continue
    out.set(objectId, values)
  }
  return out
}

/** One object's complete desired profile, as the editor emits it. */
export interface ObjectLayerHeightProfile {
  objectId: number
  /** Empty clears the object's profile (falling back to its height ranges, then the default). */
  profile: readonly number[]
}

/**
 * Serialize profiles into BambuStudio's `layer_heights_profile.txt`: one
 * `object_id=<1-based ordinal>|z;h;z;h;...` line per object, six decimals, matching its writer.
 *
 * Returns `''` when nothing serializes, which CLEARS the file. Ordinals are re-derived from the
 * SAVED model so an object that moved still lands on the right slot. A profile that is odd-length
 * or shorter than {@link MIN_PROFILE_PAIRS} pairs is dropped rather than written, because
 * BambuStudio would reject it on read and the user would lose the curve silently.
 */
export function serializeLayerHeightProfiles(
  entries: ReadonlyArray<ObjectLayerHeightProfile>,
  modelXml: string
): string {
  const ordinalByObjectId = new Map<number, number>()
  parseRootModelObjectIdOrder(modelXml).forEach((id, index) => {
    if (!ordinalByObjectId.has(id)) ordinalByObjectId.set(id, index + 1)
  })
  const lines: string[] = []
  for (const entry of [...entries].sort((a, b) => a.objectId - b.objectId)) {
    const ordinal = ordinalByObjectId.get(entry.objectId)
    if (!ordinal) continue
    const profile = entry.profile
    if (profile.length % 2 !== 0 || profile.length < MIN_PROFILE_PAIRS * 2) continue
    if (profile.some((value) => !Number.isFinite(value))) continue
    lines.push(`object_id=${ordinal}|${profile.map((value) => value.toFixed(6)).join(';')}`)
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
