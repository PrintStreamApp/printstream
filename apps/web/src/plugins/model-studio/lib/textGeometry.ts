/**
 * Turning typed text into printable geometry for the editor's Text tool.
 *
 * Produces a world-unit triangle soup (9 floats per triangle) in the same shape
 * `primitivePartSoup` produces, so text rides the existing staged-import / added-part pipeline
 * rather than needing a seam of its own.
 *
 * **Holes are the whole difficulty.** A glyph is several closed contours and the inner ones are
 * counters: the bowl of an `o`, both eyes of an `8`. Extrude every contour as a solid and the text
 * looks right in outline while printing as filled blobs.
 *
 * Contours are classified by NESTING DEPTH -- how many other contours enclose them, even meaning
 * solid and odd meaning hole. Three.js's own `ShapePath.toShapes` was the obvious choice and is what
 * its `FontLoader` uses, but it decides by comparing each contour's winding against the first one,
 * and on r169 that measurably misclassifies multi-counter glyphs: `8` came back as two shapes with
 * one hole between them (one eye extruded SOLID) and `B` likewise, while single-counter glyphs like
 * `o` were fine. Passing the other `isCCW` value changed nothing, since the parameter is ignored.
 * Nesting depth needs no winding convention at all, so it is immune to whatever a given font does.
 *
 * **Font coordinates are Y-DOWN and ours are Y-UP**, so every Y is negated on the way in. With the
 * depth rule that flip is harmless; it only ever mattered because winding heuristics care.
 */
import * as THREE from 'three'
import type { Font, Path as OpentypePath } from 'opentype.js'

/** Curve subdivision per glyph segment. Studio's text is smooth at print scale; 6 is ample. */
const CURVE_SEGMENTS = 6
/** Points sampled per contour when testing containment. Enough to resolve a counter's shape. */
const CONTAINMENT_SAMPLES = 24

export interface TextGeometryOptions {
  text: string
  /** Cap height target in mm, i.e. the size a user types. */
  fontSize: number
  /** Extrusion depth in mm. */
  thickness: number
  /** Extra space between characters in mm; negative tightens. Studio's `text_gap`. */
  textGap: number
  /** Rotation about the extrusion axis, degrees. Studio's `rotate_angle`. */
  rotateAngle: number
}

/**
 * The 2D outlines for `text`, one {@link THREE.Shape} per glyph contour group, in millimetres and
 * Y-up, laid out along +X with the baseline at y = 0.
 *
 * Exported for its own sake because hole detection is the part that silently produces wrong prints,
 * and asserting on shapes is far more direct than asserting on a triangle soup.
 */
export function textShapes(font: Font, options: TextGeometryOptions): THREE.Shape[] {
  const { text, fontSize, textGap } = options
  if (!text) return []
  // opentype works in font units; scale so the em box maps to the requested size in mm.
  const scale = fontSize / font.unitsPerEm
  const shapes: THREE.Shape[] = []
  let penX = 0
  let previous: number | null = null

  for (const character of [...text]) {
    const glyph = font.charToGlyph(character)
    if (!glyph) continue
    // Applies only where the font carries a legacy `kern` table, which opentype.js reads and GPOS
    // it does not. The bundled subsets have neither, so this is a no-op for them and a benefit for
    // a user-loaded font that happens to have one.
    if (previous != null) penX += (font.getKerningValue(previous, glyph.index) || 0) * scale
    const path = glyph.getPath(penX, 0, fontSize)
    shapes.push(...shapesFromPath(path))
    penX += (glyph.advanceWidth ?? 0) * scale + textGap
    previous = glyph.index
  }
  return shapes
}

/** A closed contour: its curve, and sampled points for containment tests. */
interface Contour {
  path: THREE.Path
  points: THREE.Vector2[]
}

/** One glyph's contours as shapes, with counters attached as holes rather than as solids. */
function shapesFromPath(path: OpentypePath): THREE.Shape[] {
  const contours: Contour[] = []
  let current: THREE.Path | null = null
  for (const command of path.commands) {
    const x = command.x ?? 0
    // Negate Y: font paths are Y-down, the bed is Y-up.
    const y = -(command.y ?? 0)
    switch (command.type) {
      case 'M':
        current = new THREE.Path()
        current.moveTo(x, y)
        contours.push({ path: current, points: [] })
        break
      case 'L': current?.lineTo(x, y); break
      case 'Q': current?.quadraticCurveTo(command.x1 ?? 0, -(command.y1 ?? 0), x, y); break
      case 'C': current?.bezierCurveTo(
        command.x1 ?? 0, -(command.y1 ?? 0), command.x2 ?? 0, -(command.y2 ?? 0), x, y); break
      case 'Z': if (current) current.autoClose = true; break
      default: break
    }
  }
  for (const contour of contours) contour.points = contour.path.getPoints(CONTAINMENT_SAMPLES)

  // Depth = how many other contours enclose this one. Even is solid, odd is a hole of the
  // innermost contour that encloses it, which is what nests a counter inside the right glyph
  // rather than inside a neighbour that merely overlaps its bounding box.
  const shapes: THREE.Shape[] = []
  const shapeFor = new Map<number, THREE.Shape>()
  const enclosers = contours.map((contour, index) =>
    contours.reduce<number[]>((found, other, otherIndex) => {
      if (otherIndex !== index && contour.points.length > 0 && containsPoint(other.points, contour.points[0]!)) {
        found.push(otherIndex)
      }
      return found
    }, []))

  contours.forEach((contour, index) => {
    if (enclosers[index]!.length % 2 !== 0) return
    const shape = new THREE.Shape(contour.points)
    shape.curves = contour.path.curves
    shape.autoClose = true
    shapeFor.set(index, shape)
    shapes.push(shape)
  })
  contours.forEach((contour, index) => {
    const around = enclosers[index]!
    if (around.length % 2 === 0) return
    // The innermost enclosing SOLID is the one with the most enclosers of its own.
    const parent = around
      .filter((i) => shapeFor.has(i))
      .sort((a, b) => enclosers[b]!.length - enclosers[a]!.length)[0]
    if (parent == null) return
    const hole = new THREE.Path(contour.points)
    hole.curves = contour.path.curves
    hole.autoClose = true
    shapeFor.get(parent)!.holes.push(hole)
  })
  return shapes
}

/** Ray-casting point-in-polygon over a contour's sampled points. */
function containsPoint(polygon: ReadonlyArray<THREE.Vector2>, point: THREE.Vector2): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * Extruded triangle soup for `text`, centred on the origin in X and Y, extruded symmetrically about
 * z = 0 and rotated about Z by `rotateAngle`.
 *
 * Centred rather than floored because text is added as a PART, and a part is placed by one point
 * relative to its host (the same reason `primitivePartSoup` centres). Returns an empty array for
 * text that produces no outlines at all, e.g. a string of spaces, which the caller should treat as
 * "nothing to add" rather than as an empty part.
 */
export function buildTextSoup(font: Font, options: TextGeometryOptions): Float32Array {
  const shapes = textShapes(font, options)
  if (shapes.length === 0) return new Float32Array(0)

  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: options.thickness,
    bevelEnabled: false,
    curveSegments: CURVE_SEGMENTS
  })
  // Extrusion runs 0..thickness; centre it so the part's own middle is its origin.
  geometry.translate(0, 0, -options.thickness / 2)
  if (options.rotateAngle) geometry.rotateZ((options.rotateAngle * Math.PI) / 180)
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (box) geometry.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, 0)

  const nonIndexed = geometry.toNonIndexed()
  const positions = nonIndexed.getAttribute('position')
  const soup = new Float32Array(positions.array.length)
  soup.set(positions.array as Float32Array)
  geometry.dispose()
  nonIndexed.dispose()
  return soup
}

/**
 * Per-glyph advance widths in mm, in reading order, including the letter gap.
 *
 * This is what {@link seatGlyphs} distributes along a contour, so it must match the spacing the flat
 * layout would have produced: surface text that spaces differently from flat text of the same
 * settings reads as a different font.
 */
export function glyphAdvances(font: Font, options: TextGeometryOptions): number[] {
  const scale = options.fontSize / font.unitsPerEm
  let previous: number | null = null
  return [...options.text].map((character) => {
    const glyph = font.charToGlyph(character)
    // Kerned exactly as `textShapes` advances its pen. Without this the same word spaces one way
    // flat and another on a surface for any font carrying a `kern` table -- which is every font a
    // user is likely to load -- and the two read as different fonts.
    const kerning = previous != null && glyph
      ? (font.getKerningValue(previous, glyph.index) || 0) * scale
      : 0
    previous = glyph?.index ?? previous
    return kerning + ((glyph?.advanceWidth ?? 0) * scale) + options.textGap
  })
}

/**
 * Extruded soup for text seated on a surface: one glyph per frame, each turned to its own point on
 * the contour, welded into a single soup.
 *
 * The counterpart to {@link buildTextSoup}, which extrudes the whole run flat. Here each glyph is
 * built at the origin and then placed, which is what lets a run follow curvature -- a single flat
 * mesh can only ever be tangent at one point.
 *
 * `frames` is positional against the text's characters and may contain nulls where a glyph ran off
 * an open contour; those glyphs are skipped rather than stacked at the end.
 *
 * The soup is returned in the frames' own space (the host's), NOT centred, because the frames
 * already say where each glyph belongs.
 */
export function buildSurfaceTextSoup(
  font: Font,
  options: TextGeometryOptions,
  frames: ReadonlyArray<{ position: Vec3Like; normal: Vec3Like; tangent: Vec3Like } | null>
): Float32Array {
  const characters = [...options.text]
  const chunks: Float32Array[] = []
  const basis = new THREE.Matrix4()
  const xAxis = new THREE.Vector3()
  const yAxis = new THREE.Vector3()
  const zAxis = new THREE.Vector3()

  // Built up front so the run shares ONE vertical alignment. Every glyph is placed on its own frame,
  // which makes it tempting to centre each on its own bounding box -- and that is a typographic
  // disaster: centring vertically aligns letter CENTRES instead of BASELINES, so an `e` rides up
  // relative to a `T` and the run reads as though each letter were top-aligned. Flat text never
  // showed it because the whole run is one geometry with one baseline.
  const built = characters.map((character, index) => {
    const frame = frames[index]
    if (!frame) return null
    const shapes = textShapes(font, { ...options, text: character, textGap: 0 })
    if (shapes.length === 0) return null
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: options.thickness,
      bevelEnabled: false,
      curveSegments: CURVE_SEGMENTS
    })
    geometry.translate(0, 0, -options.thickness / 2)
    geometry.computeBoundingBox()
    return { frame, geometry, box: geometry.boundingBox }
  })

  // The run's own vertical extent, shared by every glyph, so relative heights survive while the text
  // as a whole still sits centred on the surface point the user placed it at.
  let runMinY = Infinity
  let runMaxY = -Infinity
  for (const entry of built) {
    if (!entry?.box) continue
    runMinY = Math.min(runMinY, entry.box.min.y)
    runMaxY = Math.max(runMaxY, entry.box.max.y)
  }
  const runCentreY = Number.isFinite(runMinY) ? (runMinY + runMaxY) / 2 : 0

  built.forEach((entry) => {
    if (!entry) return
    const { frame, geometry, box } = entry
    // Horizontally each glyph centres on its OWN box, because its frame is its own seat on the
    // contour. Vertically they all share the run's centre, which is what keeps the baseline.
    if (box) geometry.translate(-(box.min.x + box.max.x) / 2, -runCentreY, 0)

    // The glyph is built in XY extruding along +Z, so its axes map to the frame directly: the
    // baseline runs along the contour, and the extrusion runs out of the surface.
    zAxis.set(frame.normal.x, frame.normal.y, frame.normal.z).normalize()
    xAxis.set(frame.tangent.x, frame.tangent.y, frame.tangent.z)
    // Orthogonalise: a contour tangent is not exactly perpendicular to the surface normal on a
    // faceted mesh, and a skewed basis shears the letterforms.
    xAxis.sub(zAxis.clone().multiplyScalar(xAxis.dot(zAxis))).normalize()
    yAxis.crossVectors(zAxis, xAxis).normalize()
    basis.makeBasis(xAxis, yAxis, zAxis)
    basis.setPosition(frame.position.x, frame.position.y, frame.position.z)
    geometry.applyMatrix4(basis)

    const positions = geometry.toNonIndexed().getAttribute('position')
    chunks.push(new Float32Array(positions.array as Float32Array))
    geometry.dispose()
  })

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const soup = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) { soup.set(chunk, offset); offset += chunk.length }
  return soup
}

/** Structural minimum of a 3D vector, so this module needs no dependency on the projection's types. */
interface Vec3Like { x: number; y: number; z: number }
