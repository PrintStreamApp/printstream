/**
 * Point markers on the G-code preview: retract, unretract and seam (#92).
 *
 * Owns the diamond each marker is drawn as, and the per-layer index table that lets the layer
 * slider scrub them exactly as it scrubs beads. One merged geometry PER KIND, because the two
 * things that hide a marker are independent: a legend checkbox hides a whole kind, and the layer
 * slider hides a Z range. Merged-per-kind makes the first `mesh.visible` and the second a draw
 * range, which is the same mechanism the beads and travel lines already use; a single merged mesh
 * could not express the kind toggle, and one instanced mesh per kind could not express a
 * single-layer range, which has a start offset as well as a count.
 *
 * Ported from BambuStudio's option rendering (`LegacyRenderer.cpp:1230-1233` for the transform,
 * `GLModel.cpp:1735-1780` for the diamond). Two deliberate divergences, both stated because they
 * are visible:
 *
 * - Its diamond has a 16-segment equator; ours has 8. Studio draws one INSTANCED diamond per
 *   marker, so its segment count is nearly free; ours are merged into one buffer, where 16 would
 *   double the triangle count of a mesh that is about 0.6mm across on screen. Nothing about the
 *   silhouette of a 0.6mm diamond survives to a pixel.
 * - Markers are OFF by default, where Studio defaults Seam on (`LegacyRenderer.cpp:270-271`).
 *   This preview has always shipped without them, so defaulting one on would change what every
 *   existing user sees without them asking for it.
 *
 * Counterpart: `gcodePreview.ts` (which parses the markers and owns the layer scrub) and
 * `GcodeToolpathPanel.tsx` (whose checkboxes and swatches name them).
 */
import * as THREE from 'three'
import type { GcodeMarkerKind } from './gcodeViewModes'

/**
 * Equator segments on a marker diamond. See the module header for why this is 8 where
 * BambuStudio's `diamond(16)` is 16.
 */
const MARKER_EQUATOR_SEGMENTS = 8

/**
 * BambuStudio scales a marker by 1.5x the extrusion width in XY and 1.5x the layer height in Z
 * (`LegacyRenderer.cpp:1230-1231`), around a unit diamond of radius 0.5. So a marker on a 0.42mm
 * line is about 0.63mm across: big enough to find, small enough not to bury the bead it marks.
 */
const MARKER_SIZE_FACTOR = 1.5

export interface GcodeMarkerGeometry {
  geometry: THREE.BufferGeometry
  /** Cumulative INDEX count at the end of each layer, for the scrub draw range. */
  layerIndexEnd: number[]
  /** How many markers of this kind exist at all; 0 means do not build a mesh. */
  markerCount: number
}

/**
 * Unit diamond: an `MARKER_EQUATOR_SEGMENTS`-gon equator at radius 0.5 with apexes at +/-0.5 Z.
 *
 * Returned as flat arrays rather than a geometry because every marker is a translated, scaled
 * copy baked into one buffer, so the template is only ever read, never rendered.
 */
function diamondTemplate(): { positions: Float32Array; indices: Uint16Array } {
  const segments = MARKER_EQUATOR_SEGMENTS
  // apex top, apex bottom, then the equator ring.
  const positions = new Float32Array((2 + segments) * 3)
  positions[2] = 0.5   // top apex at (0, 0, +0.5)
  positions[5] = -0.5  // bottom apex at (0, 0, -0.5)
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    const o = (2 + i) * 3
    positions[o] = Math.cos(angle) * 0.5
    positions[o + 1] = Math.sin(angle) * 0.5
    positions[o + 2] = 0
  }
  const indices = new Uint16Array(segments * 6)
  for (let i = 0; i < segments; i++) {
    const a = 2 + i
    const b = 2 + ((i + 1) % segments)
    // Wound so both cones face outward, matching the front-side culling the preview uses.
    indices[i * 6] = 0; indices[i * 6 + 1] = a; indices[i * 6 + 2] = b
    indices[i * 6 + 3] = 1; indices[i * 6 + 4] = b; indices[i * 6 + 5] = a
  }
  return { positions, indices }
}

/**
 * Merge every marker of one kind into a single indexed geometry, ordered by layer.
 *
 * Ordering by layer is what makes the scrub an O(1) draw-range change: `layerIndexEnd[n]` is
 * where the markers at or below layer `n` stop. Markers are not vertex-coloured, because a whole
 * mesh is one kind and one colour, so the material carries it.
 */
export function buildGcodeMarkerGeometry(
  parsed: {
    markerPositions: Float32Array
    markerKinds: Uint8Array
    markerWidths: Float32Array
    markerHeights: Float32Array
    markerLayerEnd: number[]
    layerCount: number
  },
  kind: GcodeMarkerKind
): GcodeMarkerGeometry {
  const template = diamondTemplate()
  const templateVertices = template.positions.length / 3
  const templateIndices = template.indices.length

  let markerCount = 0
  for (let i = 0; i < parsed.markerKinds.length; i++) if (parsed.markerKinds[i] === kind) markerCount += 1
  if (markerCount === 0) {
    return { geometry: new THREE.BufferGeometry(), layerIndexEnd: parsed.markerLayerEnd.map(() => 0), markerCount: 0 }
  }

  const positions = new Float32Array(markerCount * templateVertices * 3)
  const normals = new Float32Array(markerCount * templateVertices * 3)
  const indices = markerCount * templateVertices > 65536
    ? new Uint32Array(markerCount * templateIndices)
    : new Uint16Array(markerCount * templateIndices)
  const layerIndexEnd: number[] = []

  let vertexCursor = 0
  let indexCursor = 0
  const normal = new THREE.Vector3()
  for (let layer = 0; layer < parsed.layerCount; layer++) {
    const start = layer > 0 ? parsed.markerLayerEnd[layer - 1]! : 0
    const end = parsed.markerLayerEnd[layer] ?? 0
    for (let marker = start; marker < end; marker++) {
      if (parsed.markerKinds[marker] !== kind) continue
      const width = (parsed.markerWidths[marker] ?? 0) * MARKER_SIZE_FACTOR
      const height = (parsed.markerHeights[marker] ?? 0) * MARKER_SIZE_FACTOR
      const px = parsed.markerPositions[marker * 3]!
      const py = parsed.markerPositions[marker * 3 + 1]!
      // Studio centres the diamond half a LAYER HEIGHT below the move's position, so it straddles
      // the bead rather than floating on top of it (`LegacyRenderer.cpp:1232`). That is the
      // unscaled height, not the scaled one.
      const pz = parsed.markerPositions[marker * 3 + 2]! - (parsed.markerHeights[marker] ?? 0) * 0.5

      const base = vertexCursor
      for (let v = 0; v < templateVertices; v++) {
        const o = (vertexCursor + v) * 3
        const tx = template.positions[v * 3]! * width
        const ty = template.positions[v * 3 + 1]! * width
        const tz = template.positions[v * 3 + 2]! * height
        positions[o] = px + tx
        positions[o + 1] = py + ty
        positions[o + 2] = pz + tz
        // The template is a convex body centred on its own origin, so the outward normal is just
        // the normalized offset. Computed against the SCALED offsets, or a flat marker (height
        // much smaller than width) would shade as though it were a sphere.
        normal.set(tx, ty, tz)
        if (normal.lengthSq() > 0) normal.normalize()
        normals[o] = normal.x
        normals[o + 1] = normal.y
        normals[o + 2] = normal.z
      }
      for (let i = 0; i < templateIndices; i++) indices[indexCursor + i] = base + template.indices[i]!
      vertexCursor += templateVertices
      indexCursor += templateIndices
    }
    layerIndexEnd.push(indexCursor)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  // Bounds are computed here rather than lazily: the preview frees CPU arrays after upload, and a
  // lazy compute during the renderer's sort pass would read a freed array. Same rule as the beads.
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return { geometry, layerIndexEnd, markerCount }
}
