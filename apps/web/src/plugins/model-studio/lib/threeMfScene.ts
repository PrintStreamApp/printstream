/**
 * Shared Three.js helpers for the model-studio plugin.
 *
 * Owns the 3MF geometry/scene building primitives reused by both the read-only
 * `PreviewView` and the interactive `EditorView`:
 * - `parseThreeMfModelEntry` decodes a 3MF model XML entry into per-object
 *   `BufferGeometry` (welded + smoothed + planar-patch corrected).
 * - `createThreeMfMatrix` converts a 12-element column-major 3MF transform into a
 *   `THREE.Matrix4`. This convention MUST match the backend writer exactly: the
 *   first nine numbers are the column-major 3x3 rotation/scale, the last three are
 *   the translation. Decompose into position/quaternion/scale (Euler order 'XYZ')
 *   to seed editor gizmos.
 * - `createPreviewPlateSurface` builds the bed plane + millimetre grid (10mm minor /
 *   50mm major lines with subtle edge coordinate labels) + outline.
 * - `disposeObject3D` releases geometry/material GPU resources on teardown.
 *
 * Keep these helpers free of React/plugin coupling so they remain a pure rendering
 * toolkit. A plugin must not import another plugin, so this module lives inside the
 * `model-studio` plugin directory.
 */
import * as THREE from 'three'
import { STLLoader, mergeVertices, toCreasedNormals } from 'three-stdlib'
import type { LibraryThreeMfScene } from '@printstream/shared'
import { buildApiUrl } from '../../../lib/apiUrl'
import { fetchModelText } from './modelFetch'
import { buildTrianglePaintOverlay, SUPPORT_PAINT_COLORS } from './supportPaint'

export const THREE_MF_VERTEX_WELD_TOLERANCE = 5e-2
export const THREE_MF_SMOOTH_NORMAL_ANGLE = THREE.MathUtils.degToRad(45)
export const THREE_MF_BED_CLEARANCE_THRESHOLD = 0.35

/** Bed grid spacing (mm): fine lines every minor step, emphasized lines every major step. */
export const BED_GRID_MINOR_STEP_MM = 10
export const BED_GRID_MAJOR_STEP_MM = 50

/**
 * Convert a 12-element 3MF transform (column-major 3x3 followed by translation)
 * into a `THREE.Matrix4`. Reuse for both rendering and gizmo seeding.
 */
export function createThreeMfMatrix(transform: number[]): THREE.Matrix4 {
  const matrix = new THREE.Matrix4()
  matrix.set(
    transform[0] ?? 1, transform[3] ?? 0, transform[6] ?? 0, transform[9] ?? 0,
    transform[1] ?? 0, transform[4] ?? 1, transform[7] ?? 0, transform[10] ?? 0,
    transform[2] ?? 0, transform[5] ?? 0, transform[8] ?? 1, transform[11] ?? 0,
    0, 0, 0, 1
  )
  return matrix
}

/** Inverse of {@link createThreeMfMatrix}: serialize a Matrix4 to the 12-element 3MF layout. */
export function threeMfTransformFromMatrix(matrix: THREE.Matrix4): number[] {
  const e = matrix.elements // THREE stores column-major; 3MF wants the three basis columns + translation
  return [
    e[0] ?? 1, e[1] ?? 0, e[2] ?? 0,
    e[4] ?? 0, e[5] ?? 1, e[6] ?? 0,
    e[8] ?? 0, e[9] ?? 0, e[10] ?? 1,
    e[12] ?? 0, e[13] ?? 0, e[14] ?? 0
  ]
}

/**
 * Per-triangle paint codes parsed from a mesh's `paint_supports`/`paint_seam`
 * attributes, keyed by triangle index in mesh order ('4' enforcer, '8' blocker, longer
 * hex strings are Bambu/Prusa sub-triangle split codes preserved verbatim). Stored on
 * `geometry.userData.supportPaint` / `geometry.userData.seamPaint`; the
 * welding/smoothing pipeline preserves triangle order and count, so index i still
 * addresses source triangle i on the final geometry.
 */
export type SupportPaintCodes = Record<number, string>

/**
 * Brush channels sharing the triangle-paint encoding: support enforcers/blockers
 * (`paint_supports`), seam (`paint_seam`), and Bambu's multi-material colour painting
 * (`paint_color`, whole-triangle states mapping to 1-based filament ids).
 */
export type TrianglePaintChannel = 'supports' | 'seam' | 'color'

const PAINT_USER_DATA_KEYS: Record<TrianglePaintChannel, 'supportPaint' | 'seamPaint' | 'colorPaint'> = {
  supports: 'supportPaint',
  seam: 'seamPaint',
  color: 'colorPaint'
}

/** Read a channel's parsed paint from `geometry.userData`, if present. */
export function getGeometryTrianglePaint(
  geometry: THREE.BufferGeometry,
  channel: TrianglePaintChannel
): SupportPaintCodes | null {
  const paint = (geometry.userData as Record<string, SupportPaintCodes | undefined>)[PAINT_USER_DATA_KEYS[channel]]
  return paint && Object.keys(paint).length > 0 ? paint : null
}

/**
 * Parse a 3MF model XML entry into a map of Bambu `object_id` to `BufferGeometry`.
 * Geometry is welded, smoothed, and planar-patch corrected so flat faces read
 * cleanly. Empty objects (no mesh, no triangles) are skipped. Existing support
 * paint is captured on `geometry.userData.supportPaint` (see {@link SupportPaintCodes}).
 */
export function parseThreeMfModelEntry(xmlText: string): Map<number, THREE.BufferGeometry> {
  const parser = new DOMParser()
  const document = parser.parseFromString(xmlText, 'application/xml')
  if (document.querySelector('parsererror')) {
    throw new Error('Invalid 3MF model data.')
  }

  const geometries = new Map<number, THREE.BufferGeometry>()
  for (const objectNode of Array.from(document.getElementsByTagName('object'))) {
    const objectId = Number.parseInt(objectNode.getAttribute('id') ?? '', 10)
    if (!Number.isInteger(objectId) || objectId <= 0) continue
    const meshNode = objectNode.getElementsByTagName('mesh')[0]
    if (!meshNode) continue

    const vertexNodes = Array.from(meshNode.getElementsByTagName('vertex'))
    const triangleNodes = Array.from(meshNode.getElementsByTagName('triangle'))
    if (vertexNodes.length === 0 || triangleNodes.length === 0) continue

    const positions = new Float32Array(vertexNodes.length * 3)
    for (let index = 0; index < vertexNodes.length; index += 1) {
      const node = vertexNodes[index]
      positions[index * 3] = Number.parseFloat(node?.getAttribute('x') ?? '0')
      positions[index * 3 + 1] = Number.parseFloat(node?.getAttribute('y') ?? '0')
      positions[index * 3 + 2] = Number.parseFloat(node?.getAttribute('z') ?? '0')
    }

    const indexArray = vertexNodes.length > 65535
      ? new Uint32Array(triangleNodes.length * 3)
      : new Uint16Array(triangleNodes.length * 3)
    const supportPaint: SupportPaintCodes = {}
    const seamPaint: SupportPaintCodes = {}
    const colorPaint: SupportPaintCodes = {}
    for (let index = 0; index < triangleNodes.length; index += 1) {
      const node = triangleNodes[index]
      indexArray[index * 3] = Number.parseInt(node?.getAttribute('v1') ?? '0', 10)
      indexArray[index * 3 + 1] = Number.parseInt(node?.getAttribute('v2') ?? '0', 10)
      indexArray[index * 3 + 2] = Number.parseInt(node?.getAttribute('v3') ?? '0', 10)
      const supportCode = node?.getAttribute('paint_supports')
      if (supportCode) supportPaint[index] = supportCode
      const seamCode = node?.getAttribute('paint_seam')
      if (seamCode) seamPaint[index] = seamCode
      const colorCode = node?.getAttribute('paint_color')
      if (colorCode) colorPaint[index] = colorCode
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(indexArray, 1))
    const weldedGeometry = mergeVertices(geometry, THREE_MF_VERTEX_WELD_TOLERANCE)
    weldedGeometry.deleteAttribute('normal')
    const smoothedGeometry = toCreasedNormals(weldedGeometry, THREE_MF_SMOOTH_NORMAL_ANGLE)
    const correctedGeometry = flattenPlanarPatchNormals(smoothedGeometry)
    correctedGeometry.computeBoundingSphere()
    if (Object.keys(supportPaint).length > 0) correctedGeometry.userData.supportPaint = supportPaint
    if (Object.keys(seamPaint).length > 0) correctedGeometry.userData.seamPaint = seamPaint
    if (Object.keys(colorPaint).length > 0) correctedGeometry.userData.colorPaint = colorPaint
    geometries.set(objectId, correctedGeometry)
  }

  return geometries
}

/**
 * Decode a binary (or ASCII) STL buffer into a single `BufferGeometry` for an
 * imported foreign mesh. All staged imports (STL and server-tessellated STEP) are
 * served as STL, so this is the one rendering path for import-backed instances.
 * Vertex normals are computed so flat faces shade consistently with 3MF geometry.
 */
export function parseStlGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
  const geometry = new STLLoader().parse(buffer)
  geometry.deleteAttribute('normal')
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

function flattenPlanarPatchNormals(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const nonIndexedGeometry = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  if (!nonIndexedGeometry.getAttribute('normal')) {
    nonIndexedGeometry.computeVertexNormals()
  }

  const positionAttribute = nonIndexedGeometry.getAttribute('position')
  const normalAttribute = nonIndexedGeometry.getAttribute('normal')
  if (!positionAttribute || !normalAttribute) {
    return nonIndexedGeometry
  }

  const triangleCount = Math.floor(positionAttribute.count / 3)
  const normals = new Float32Array(normalAttribute.array)
  const planarBuckets = new Map<string, { triangles: number[]; normal: THREE.Vector3 }>()
  const vertexA = new THREE.Vector3()
  const vertexB = new THREE.Vector3()
  const vertexC = new THREE.Vector3()
  const edgeAB = new THREE.Vector3()
  const edgeAC = new THREE.Vector3()
  const faceNormal = new THREE.Vector3()

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const offset = triangleIndex * 3
    vertexA.fromBufferAttribute(positionAttribute, offset)
    vertexB.fromBufferAttribute(positionAttribute, offset + 1)
    vertexC.fromBufferAttribute(positionAttribute, offset + 2)
    edgeAB.subVectors(vertexB, vertexA)
    edgeAC.subVectors(vertexC, vertexA)
    faceNormal.crossVectors(edgeAB, edgeAC)
    if (faceNormal.lengthSq() < 1e-10) continue
    faceNormal.normalize()

    const bucketKey = [
      Math.round(faceNormal.x * 250),
      Math.round(faceNormal.y * 250),
      Math.round(faceNormal.z * 250)
    ].join('|')
    const bucket = planarBuckets.get(bucketKey)
    if (bucket) {
      bucket.triangles.push(triangleIndex)
      bucket.normal.add(faceNormal)
    } else {
      planarBuckets.set(bucketKey, {
        triangles: [triangleIndex],
        normal: faceNormal.clone()
      })
    }
  }

  for (const bucket of planarBuckets.values()) {
    if (bucket.triangles.length < 2) continue
    const bucketNormal = bucket.normal.normalize()
    for (const triangleIndex of bucket.triangles) {
      const normalOffset = triangleIndex * 9
      for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
        normals[normalOffset + vertexIndex * 3] = bucketNormal.x
        normals[normalOffset + vertexIndex * 3 + 1] = bucketNormal.y
        normals[normalOffset + vertexIndex * 3 + 2] = bucketNormal.z
      }
    }
  }

  nonIndexedGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  return nonIndexedGeometry
}

/**
 * Build the bed surface for a plate: a translucent plane and a millimetre grid with edge
 * coordinate labels, centred at `(centerX, centerY)` on the z=0 plane. The print area gets no
 * border square — the grid is the plate.
 */
export function createPreviewPlateSurface({
  width,
  depth,
  centerX,
  centerY,
  excludeAreas = [],
  showSurfaceFill = true,
  axisLabelEdge = 'front'
}: {
  width: number
  depth: number
  centerX: number
  centerY: number
  /** Unprintable / single-nozzle zones (bed coords, absolute) with optional labels. */
  excludeAreas?: Array<{ polygon: Array<{ x: number; y: number }>; label?: string | null }>
  /**
   * Draw the tinted surface fill. Turned off when the real 3D build plate is rendered underneath,
   * where it only z-fights the mesh. Everything else — grid, measurement ticks, unprintable zones
   * — is drawn either way; the modelled plate supplies a surface, not a scale.
   */
  showSurfaceFill?: boolean
  /**
   * Which edge the measurement ticks run along. `rear` is used with the 3D plate: every bed mesh
   * extends well past the print area at the FRONT for its handle (H2D: -18.5mm), so front ticks
   * would land on top of it — the rear edge is clear.
   */
  axisLabelEdge?: 'front' | 'rear'
}): THREE.Object3D {
  const plateGroup = new THREE.Group()

  const minX = centerX - width / 2
  const maxX = centerX + width / 2
  const minY = centerY - depth / 2
  const maxY = centerY + depth / 2

  if (showSurfaceFill) {
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({
        color: 0x1b2636,
        transparent: true,
        opacity: 0.74,
        roughness: 0.94,
        metalness: 0.03,
        side: THREE.FrontSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
      })
    )
    bed.position.set(centerX, centerY, -0.05)
    bed.renderOrder = -1
    bed.receiveShadow = true
    plateGroup.add(bed)
  }
  // The grid and the measurement ticks are the plate's SCALE, which the modelled bed does not
  // provide, so both are drawn in either presentation. The print area is deliberately NOT
  // outlined with a border square: the grid alone reads as the plate, and the border only added
  // a hard frame around it (the modelled bed already shows the physical plate edge).
  plateGroup.add(createBedGridLines(minX, maxX, minY, maxY))
  plateGroup.add(createBedAxisLabels(minX, maxX, minY, maxY, axisLabelEdge))

  // Unprintable / single-nozzle zones: a translucent red fill, diagonal hatching, a
  // bright outline, and (when present) a Bambu-style text label so the user can see
  // where models can't print or which nozzle is required.
  for (const zone of excludeAreas) {
    const polygon = zone.polygon
    if (polygon.length < 3) continue
    // Skip degenerate/zero-area polygons (e.g. printers that report "0x0" placeholders).
    let area = 0
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i]
      const b = polygon[(i + 1) % polygon.length]
      if (a && b) area += a.x * b.y - b.x * a.y
    }
    if (Math.abs(area) < 1) continue
    const points2d = polygon.map((point) => new THREE.Vector2(point.x, point.y))
    const shape = new THREE.Shape(points2d)

    const fill = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color: 0xc2412f, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide })
    )
    fill.position.z = 0.015
    fill.renderOrder = 1
    plateGroup.add(fill)

    // Diagonal hatch lines clipped to the polygon for a subtle "no-go" look.
    const hatch = createPolygonHatchLines(points2d, 8)
    if (hatch) {
      const hatchLines = new THREE.LineSegments(
        hatch,
        new THREE.LineBasicMaterial({ color: 0xc26a58, transparent: true, opacity: 0.22, depthWrite: false })
      )
      hatchLines.position.z = 0.018
      hatchLines.renderOrder = 2
      plateGroup.add(hatchLines)
    }

    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(polygon.map((point) => new THREE.Vector3(point.x, point.y, 0.02))),
      new THREE.LineBasicMaterial({ color: 0xc26a58, transparent: true, opacity: 0.4, depthWrite: false })
    )
    border.renderOrder = 3
    plateGroup.add(border)

    if (zone.label) {
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const point of points2d) {
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
      }
      const label = createZoneLabel(zone.label, (minX + maxX) / 2, (minY + maxY) / 2, maxX - minX, maxY - minY)
      if (label) plateGroup.add(label)
    }
  }

  return plateGroup
}

/**
 * Bed grid in true millimetres: fine lines every {@link BED_GRID_MINOR_STEP_MM},
 * emphasized lines every {@link BED_GRID_MAJOR_STEP_MM}, anchored to absolute bed
 * coordinates (so a 0-based Bambu bed gets lines exactly at 0/10/20…mm).
 * Returns a group of two `LineSegments`: minor lines first, major lines second.
 * Exported for tests; rendering callers go through `createPreviewPlateSurface`.
 */
export function createBedGridLines(minX: number, maxX: number, minY: number, maxY: number): THREE.Object3D {
  const minorVertices: number[] = []
  const majorVertices: number[] = []
  const firstX = Math.ceil(minX / BED_GRID_MINOR_STEP_MM) * BED_GRID_MINOR_STEP_MM
  for (let x = firstX; x <= maxX + 1e-6; x += BED_GRID_MINOR_STEP_MM) {
    const target = Math.round(x) % BED_GRID_MAJOR_STEP_MM === 0 ? majorVertices : minorVertices
    target.push(x, minY, 0, x, maxY, 0)
  }
  const firstY = Math.ceil(minY / BED_GRID_MINOR_STEP_MM) * BED_GRID_MINOR_STEP_MM
  for (let y = firstY; y <= maxY + 1e-6; y += BED_GRID_MINOR_STEP_MM) {
    const target = Math.round(y) % BED_GRID_MAJOR_STEP_MM === 0 ? majorVertices : minorVertices
    target.push(minX, y, 0, maxX, y, 0)
  }

  const group = new THREE.Group()
  const addLines = (vertices: number[], color: number, opacity: number) => {
    if (vertices.length === 0) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    group.add(new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
    ))
  }
  addLines(minorVertices, 0x223042, 0.55)
  addLines(majorVertices, 0x2a6f66, 0.5)
  group.position.z = 0.01
  return group
}

/**
 * Subtle coordinate numbers just outside the bed edges at every major grid line
 * (X along the front edge, Y along the left edge), so users can read where they
 * are placing objects in real bed millimetres.
 */
function createBedAxisLabels(minX: number, maxX: number, minY: number, maxY: number, edge: 'front' | 'rear' = 'front'): THREE.Object3D {
  const group = new THREE.Group()
  // mm of text height on the bed. Sized to stay legible when the whole bed is in
  // view (a 256mm plate): at 5mm the numbers were an invisible speck until heavily
  // zoomed in. The labels lie flat on the bed (see createAxisTickLabel), like
  // markings printed on the plate itself.
  const labelHeight = 9
  const margin = labelHeight * 0.9
  const firstX = Math.ceil(minX / BED_GRID_MAJOR_STEP_MM) * BED_GRID_MAJOR_STEP_MM
  for (let x = firstX; x <= maxX + 1e-6; x += BED_GRID_MAJOR_STEP_MM) {
    const label = createAxisTickLabel(String(Math.round(x)), labelHeight)
    if (!label) continue
    // Along the front edge by default; past the rear edge when the plate's handle occupies
    // the space in front of the print area.
    label.position.set(x, edge === 'rear' ? maxY + margin : minY - margin, 0.02)
    group.add(label)
  }
  const firstY = Math.ceil(minY / BED_GRID_MAJOR_STEP_MM) * BED_GRID_MAJOR_STEP_MM
  for (let y = firstY; y <= maxY + 1e-6; y += BED_GRID_MAJOR_STEP_MM) {
    const label = createAxisTickLabel(String(Math.round(y)), labelHeight)
    if (!label) continue
    label.position.set(minX - margin, y, 0.02)
    group.add(label)
  }
  return group
}

/**
 * A numeric tick label lying FLAT on the bed at a bed edge, sized in bed millimetres.
 *
 * It scales with the bed/grid (`heightMm` is real bed millimetres), so the
 * numbers line up with the grid lines they annotate at every zoom level. The
 * size is chosen so they remain readable when the whole plate is in view rather
 * than only once the camera is zoomed in close.
 *
 * Flat-on-the-bed is a deliberate user preference over the earlier camera-facing
 * Sprite (billboarding read as odd): the numbers behave like markings printed on
 * the plate, which means they DO foreshorten at grazing camera angles. That is
 * accepted; the historical "numbers fade away when zoomed out" bug was the mipmap
 * alpha-collapse below, not the flat orientation — keep mipmaps off either way.
 */
function createAxisTickLabel(text: string, heightMm: number): THREE.Object3D | null {
  const fontSize = 44
  const padding = 8
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return null
  context.font = `500 ${fontSize}px sans-serif`
  const textWidth = context.measureText(text).width
  canvas.width = Math.ceil(textWidth + padding * 2)
  canvas.height = fontSize + padding * 2
  context.font = `500 ${fontSize}px sans-serif`
  context.fillStyle = 'rgba(176, 202, 214, 0.95)'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, canvas.width / 2, canvas.height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  // NO mipmaps — this is what keeps the numbers visible at every zoom. The canvas is a thin glyph
  // on a fully transparent background, so mip levels average the glyph away with transparent black:
  // once the label minifies past the base level (any zoomed-out view), sampled alpha collapses to
  // ~0 and the number disappears entirely (verified by pixel probe: brightest pixel 35 -> 197 after
  // disabling). Plain linear sampling aliases slightly when small but can never null the glyph.
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  const aspect = canvas.width / canvas.height
  // PlaneGeometry lies in the XY (bed) plane with +Y as the text's up direction, so the
  // numbers read upright from the default front view with their tops pointing into the bed.
  // double-sided so they also read (mirrored) from below the bed plane.
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(aspect * heightMm, heightMm),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })
  )
  // Draw over the bed/grid rather than z-fighting with them (the caller lifts it to z=0.02).
  label.renderOrder = 4
  return label
}

/**
 * Build a flat text label that lies on the bed and is scaled + rotated to fit inside
 * a zone's bounding box (running along its long axis), so labels read clearly within
 * thin nozzle-only strips rather than overflowing them.
 */
function createZoneLabel(text: string, centerX: number, centerY: number, boxWidth: number, boxHeight: number): THREE.Object3D | null {
  const fontSize = 48
  const padding = 10
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return null
  context.font = `600 ${fontSize}px sans-serif`
  const textWidth = context.measureText(text).width
  canvas.width = Math.ceil(textWidth + padding * 2)
  canvas.height = fontSize + padding * 2
  context.font = `600 ${fontSize}px sans-serif`
  context.fillStyle = 'rgba(220, 150, 130, 0.9)'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, canvas.width / 2, canvas.height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  // NO mipmaps, same as createAxisTickLabel above and for the same reason: a thin glyph on a
  // fully transparent canvas mip-averages toward transparent black, so a flat-on-bed label
  // viewed at distance (grazing angle = deep mip levels) faded toward invisible. Linear
  // sampling aliases slightly when minified but can never null the glyph. (Anisotropy only
  // affects mip sampling, so there is none to configure without mipmaps.)
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  const aspect = canvas.width / canvas.height
  // Run the label along the box's long axis; rotate 90 deg for tall, thin zones.
  const vertical = boxHeight > boxWidth
  const alongLen = vertical ? boxHeight : boxWidth
  const acrossLen = vertical ? boxWidth : boxHeight
  const margin = 0.85
  // Fit: text length (aspect * scale) within alongLen, text height (scale) within acrossLen.
  const scale = Math.min((alongLen * margin) / aspect, acrossLen * margin)
  if (!Number.isFinite(scale) || scale <= 0) return null

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(aspect * scale, scale),
    // Depth-tested so models occlude the label (it floats just above the bed
    // plane); depthWrite stays off so the transparent quad never clips the
    // hatch lines beneath it. renderOrder draws it after the transparent bed.
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  )
  if (vertical) mesh.rotation.z = Math.PI / 2
  mesh.position.set(centerX, centerY, 0.05)
  mesh.renderOrder = 4
  return mesh
}

/**
 * Build diagonal hatch line segments clipped to a polygon (even-odd scan against the
 * polygon edges), for rendering Bambu-style unprintable zones. Returns null if the
 * polygon has no area.
 */
function createPolygonHatchLines(points: THREE.Vector2[], spacing: number): THREE.BufferGeometry | null {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  if (!Number.isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0) return null

  const vertices: number[] = []
  // Sweep lines of slope 1 (y = x + c); for each, find spans inside the polygon.
  const cStart = minY - maxX
  const cEnd = maxY - minX
  for (let c = cStart; c <= cEnd; c += spacing * Math.SQRT2) {
    const crossings: number[] = []
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      if (!a || !b) continue
      // Edge param t where the diagonal y - x = c intersects segment a->b.
      const da = a.y - a.x - c
      const db = b.y - b.x - c
      if ((da > 0) === (db > 0)) continue
      const t = da / (da - db)
      crossings.push(a.x + t * (b.x - a.x))
    }
    crossings.sort((left, right) => left - right)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const x0 = crossings[i]
      const x1 = crossings[i + 1]
      if (x0 == null || x1 == null) continue
      vertices.push(x0, x0 + c, 0, x1, x1 + c, 0)
    }
  }
  if (vertices.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  return geometry
}

/**
 * True for non-printed helper volumes (support blockers/enforcers, modifier and negative
 * parts). Note Bambu marks ordinary parts as `subtype="normal_part"` — a present subtype
 * does NOT imply a modifier, so callers must use this predicate rather than truthiness.
 */
export function isModifierVolumeSubtype(subtype: string | null): boolean {
  return modifierVolumeColor(subtype) !== null
}

/**
 * Render colour for a special part subtype (support blocker/enforcer, modifier/negative volume),
 * mirroring BambuStudio's translucent volume colours, or null for a normal printed part.
 */
function modifierVolumeColor(subtype: string | null): number | null {
  if (!subtype) return null
  switch (subtype.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')) {
    case 'supportblocker': return 0xff4d4d // translucent red
    case 'supportenforcer': return 0x4d4dff // translucent blue
    case 'modifierpart':
    case 'parametermodifier': return 0x9aa0b3 // translucent grey-blue
    case 'negativepart':
    case 'negativevolume': return 0xcfd4dc // translucent light grey
    default: return null
  }
}

/**
 * Build the renderable object for one 3MF/STL part: a shaded mesh plus, for parts
 * resting on the bed, subtle edge outlines — matching the read-only preview so the
 * editor and preview render identically.
 *
 * `transform` is applied to the mesh/edges (a part's component transform, or null
 * when the geometry is already in the parent's frame). `clearanceTransform` (the
 * full geometry→world transform, defaults to `transform`) decides whether the part
 * clears the bed, which selects the floating (shadow-casting, smoother) vs grounded
 * (edge-outlined) material — so the caller can account for a parent placement that
 * is applied to the group rather than the mesh.
 */
export function createThreeMfPartObject(
  geometry: THREE.BufferGeometry,
  options: {
    color?: string | null
    transform?: THREE.Matrix4 | null
    clearanceTransform?: THREE.Matrix4 | null
    subtype?: string | null
    /**
     * Project filament palette (1-based ids). When provided, the part's parsed
     * `paint_color` triangles render as an overlay tinted with these colours — used by
     * the read-only previews/thumbnails (the editor manages its own live overlays).
     */
    colorPaintFilaments?: ReadonlyArray<{ id: number; color: string | null }> | null
  }
): THREE.Group {
  const group = new THREE.Group()
  const baseGeometry = geometry.clone()
  baseGeometry.computeBoundingBox()
  const clearanceTransform = options.clearanceTransform ?? options.transform ?? null
  const clearanceBounds = clearanceTransform
    ? baseGeometry.boundingBox?.clone().applyMatrix4(clearanceTransform)
    : baseGeometry.boundingBox
  const hasBedClearance = (clearanceBounds?.min.z ?? 0) > THREE_MF_BED_CLEARANCE_THRESHOLD

  // Support blockers/enforcers and modifier/negative volumes render as translucent coloured
  // volumes (BambuStudio-style) and don't participate in resting/collision/clearance — they're
  // tagged isModifier so the editor's bounds + footprint checks skip them.
  const modifierColor = modifierVolumeColor(options.subtype ?? null)
  if (modifierColor !== null) {
    const mesh = new THREE.Mesh(
      baseGeometry,
      new THREE.MeshStandardMaterial({
        color: modifierColor,
        transparent: true,
        opacity: 0.45,
        roughness: 0.6,
        metalness: 0.0,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    )
    if (options.transform) mesh.applyMatrix4(options.transform)
    mesh.renderOrder = 3
    mesh.userData.isModifier = true
    group.userData.isModifier = true
    group.add(mesh)
    return group
  }

  const partColor = new THREE.Color(options.color ?? '#D3DDE7')
  const mesh = new THREE.Mesh(
    baseGeometry,
    // Brighter, more saturated filament look closer to BambuStudio: lower roughness and a stronger
    // self-colour emissive lift so the part reads vivid (not muddy) under the editor/thumbnail lights.
    new THREE.MeshStandardMaterial({
      color: partColor,
      emissive: partColor.clone().multiplyScalar(0.12),
      roughness: hasBedClearance ? 0.5 : 0.55,
      metalness: 0.0
    })
  )
  if (options.transform) mesh.applyMatrix4(options.transform)
  mesh.castShadow = hasBedClearance
  mesh.receiveShadow = true
  if (options.colorPaintFilaments) {
    const codes = getGeometryTrianglePaint(baseGeometry, 'color')
    if (codes) {
      const palette = new Map(options.colorPaintFilaments.map((filament) => [filament.id, filament.color]))
      const overlay = buildTrianglePaintOverlay(baseGeometry, codes, {
        palette: SUPPORT_PAINT_COLORS,
        name: 'colorPaintOverlay',
        offsetFactor: -4,
        colorForState: (state) => {
          const hex = palette.get(state)
          return hex ? new THREE.Color(hex).getHex() : null
        }
      })
      if (overlay) mesh.add(overlay)
    }
  }
  group.add(mesh)

  if (!hasBedClearance) {
    const edgeLines = new THREE.LineSegments(
      new THREE.EdgesGeometry(baseGeometry.clone(), 28),
      new THREE.LineBasicMaterial({ color: 0x09111d, transparent: true, opacity: 0.16, depthWrite: false })
    )
    edgeLines.scale.multiplyScalar(1.0004)
    if (options.transform) edgeLines.applyMatrix4(options.transform)
    edgeLines.renderOrder = 2
    group.add(edgeLines)
  }

  return group
}

/** Release geometry/material GPU resources for an object and its descendants. */
/** Dispose a material AND any textures it holds — `Material.dispose()` does not free `.map` etc. */
export function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose()
  }
  material.dispose()
}

export function disposeObject3D(object: THREE.Object3D): void {
  object.traverse((child) => {
    const disposable = child as THREE.Object3D & {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    disposable.geometry?.dispose()
    if (Array.isArray(disposable.material)) {
      disposable.material.forEach(disposeMaterial)
    } else if (disposable.material) {
      disposeMaterial(disposable.material)
    }
  })
}

/**
 * Build a plated 3MF scene's MESH parts (coloured by material) as a group — no plate
 * surface. Shared by the modal previewer (which adds a plate around it) and the library
 * thumbnail fallback (which wants the bare model at Bambu's iso angle). Throws if no
 * previewable geometry is found.
 */
export async function buildThreeMfMeshGroup(
  fileId: string,
  scene: LibraryThreeMfScene,
  signal?: AbortSignal
): Promise<THREE.Group> {
  const group = new THREE.Group()
  const entryPaths = [...new Set(scene.parts.map((part) => part.entryPath))]
  const modelMaps = new Map<string, Map<number, THREE.BufferGeometry>>()
  await Promise.all(entryPaths.map(async (entryPath) => {
    // Stall-guarded fetch (web->API->bridge can wedge mid-body): match the
    // editor/preview scene-entry loads rather than a bare fetch().text().
    const xml = await fetchModelText(buildApiUrl(`/api/library/${fileId}/scene-entry?path=${encodeURIComponent(entryPath)}`), { credentials: 'include', signal })
    modelMaps.set(entryPath, parseThreeMfModelEntry(xml))
  }))

  let placedPartCount = 0
  for (const part of scene.parts) {
    const geometry = modelMaps.get(part.entryPath)?.get(part.objectId)
    if (!geometry) continue
    group.add(createThreeMfPartObject(geometry, {
      // Parts without an extruder render in the DEFAULT filament, like Bambu Studio.
      color: part.color ?? scene.projectFilaments?.[0]?.color ?? null,
      transform: createThreeMfMatrix(part.transform),
      subtype: part.subtype,
      colorPaintFilaments: scene.projectFilaments ?? null
    }))
    placedPartCount += 1
  }
  if (placedPartCount === 0) {
    disposeObject3D(group)
    throw new Error('This plate does not include previewable mesh geometry.')
  }
  return group
}
