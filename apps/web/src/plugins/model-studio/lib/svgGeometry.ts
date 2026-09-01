/**
 * SVG artwork as extruded, printable triangles.
 *
 * The counterpart of `textGeometry.ts`, and deliberately the same shape: parse a 2D source into
 * `THREE.Shape`s, extrude them, and hand back a centred triangle soup the editor stages exactly like
 * an imported mesh. Everything downstream (staging, placement, part subtypes) is shared with the
 * text tool, so this module owns only what is specific to SVG.
 *
 * Three things about SVG that this has to get right, none of which apply to glyphs:
 *
 * 1. **Y points DOWN in SVG and UP in 3D.** Extruding the loader's output as-is mirrors the artwork,
 *    which is invisible on a symmetric logo and obvious on anything with lettering. Corrected by
 *    ROTATING the extruded solid 180 degrees about X, never by mirroring Y. Mirroring any single
 *    axis reverses orientation, which reverses every contour's winding and turns the solid
 *    inside-out: measured on a real 12-path logo, 2596 side-wall normals pointed inward against 1282
 *    outward, and it rendered as a featureless slab instead of the artwork. A simple test shape hides
 *    this completely, because an inside-out slab still looks like a slab.
 * 2. **SVG user units are not millimetres.** A file's coordinates may be any scale at all, so the
 *    caller asks for a WIDTH in mm and the artwork is scaled to it, keeping the source aspect.
 * 3. **Only filled paths make solids.** A stroke-only drawing produces no shapes, and the honest
 *    answer is "nothing to add" rather than an empty part -- the same contract `buildTextSoup` has
 *    for a string of spaces.
 */
import * as THREE from 'three'
import { SVGLoader } from 'three-stdlib'

/** Matches the text tool, so curved artwork and curved glyphs are tessellated alike. */
const CURVE_SEGMENTS = 12

/**
 * One source element's outlines, kept together and kept SEPARATE from its neighbours.
 *
 * Grouped per element because that is the unit a person drew and the unit they want back: a logo's
 * background, its ring and its emblem are three things, and merging them into one soup makes the
 * background impossible to delete and the emblem impossible to give its own filament. BambuStudio
 * tracks the same grouping internally (a `unique_id` per shape) before flattening it into one
 * volume.
 */
export interface SvgPiece {
  /** Fillable outlines from this element, holes already nested. Empty for a stroked piece. */
  shapes: THREE.Shape[]
  /**
   * A STROKED element, already tessellated flat by the loader (triples of x,y,z at z = 0).
   *
   * Strokes cannot be expressed as outlines to extrude: a stroke is a ribbon of a given width around
   * a path, with joins and caps, and turning that back into a closed outline is a polygon-offset
   * problem. The loader already solves the hard half by triangulating the ribbon, so this carries
   * those triangles and {@link extrudePlanarTriangles} gives them thickness.
   */
  strokeTriangles: Float32Array | null
  /** Bounds of this piece alone, source units, for naming and for ordering by size. */
  width: number
  height: number
}

/** Parsed artwork: its pieces, plus the bounds they occupy together. */
export interface ParsedSvg {
  /** In document order, which is paint order: the background, if there is one, is usually first. */
  pieces: SvgPiece[]
  /** Source bounding box over ALL pieces, for scaling and for the panel's height readout. */
  width: number
  height: number
}

/**
 * Read SVG markup into extrudable shapes.
 *
 * Requires a DOM: the loader parses markup with `DOMParser`, so this only runs in the browser (or a
 * jsdom test). That is consistent with the rest of the editor, which reads the user's file in the
 * tab and never uploads it.
 *
 * Each `<path>` contributes its own shapes with its own holes. Fills that overlap ACROSS paths are
 * not unioned, so they extrude as overlapping solids: the slicer resolves that into one body, which
 * is what BambuStudio's own SVG import does too.
 */
export function parseSvgShapes(markup: string): ParsedSvg {
  const parsed = new SVGLoader().parse(markup)
  const pieces: SvgPiece[] = []
  const whole = emptyBox()
  for (const path of parsed.paths) {
    const style = path.userData?.style
    // A path can carry BOTH a fill and a stroke, and they are different solids: BambuStudio splits
    // them the same way (one `unique_id` per fill and per stroke). Extruding only the fill loses the
    // outline of a line-art drawing entirely, which is what "this file has no filled shapes" used to
    // mean for anything drawn as strokes.
    if (isFilled(style)) {
      // `createShapes` is what nests a path's subpaths into holes, following the fill rule the loader
      // read off the element. Doing it per path rather than over the whole document keeps one path's
      // counters out of another path's outline.
      //
      // Cast because three-stdlib's own types disagree with themselves: `SVGResultPaths` (what
      // `parse` returns) re-declares `userData` as OPTIONAL, while three's `ShapePath` -- which it
      // extends, and which `createShapes` asks for -- declares it required. So the loader's output
      // does not satisfy the loader's own input. It reads `subPaths`, never `userData`.
      const shapes = SVGLoader.createShapes(path as THREE.ShapePath)
      if (shapes.length > 0) {
        const box = emptyBox()
        for (const shape of shapes) {
          // Measured in SOURCE coordinates (Y still down). The rotation that corrects that happens
          // on the extruded solid, so the axes keep the same extent and scaling is unaffected.
          expandByShape(box, shape)
          expandByShape(whole, shape)
        }
        const size = box.getSize(new THREE.Vector2())
        pieces.push({ shapes, strokeTriangles: null, width: size.x, height: size.y })
      }
    }
    const stroked = strokeTrianglesFor(path)
    if (stroked) {
      const box = emptyBox()
      const point = new THREE.Vector2()
      for (let i = 0; i < stroked.length; i += 3) {
        box.expandByPoint(point.set(stroked[i]!, stroked[i + 1]!))
        whole.expandByPoint(point)
      }
      const size = box.getSize(new THREE.Vector2())
      pieces.push({ shapes: [], strokeTriangles: stroked, width: size.x, height: size.y })
    }
  }
  if (pieces.length === 0) return { pieces, width: 0, height: 0 }
  const size = whole.getSize(new THREE.Vector2())
  return { pieces, width: size.x, height: size.y }
}

function emptyBox(): THREE.Box2 {
  return new THREE.Box2(new THREE.Vector2(Infinity, Infinity), new THREE.Vector2(-Infinity, -Infinity))
}

function expandByShape(box: THREE.Box2, shape: THREE.Shape): void {
  for (const point of shape.getPoints(CURVE_SEGMENTS)) box.expandByPoint(point)
  for (const hole of shape.holes) {
    for (const point of hole.getPoints(CURVE_SEGMENTS)) box.expandByPoint(point)
  }
}

/**
 * Whether a path's style paints an interior.
 *
 * SVG's default fill is black, so an ABSENT fill counts as filled; only an explicit `none` or a
 * fully transparent one does not.
 */
function isFilled(style: { fill?: unknown; fillOpacity?: unknown } | undefined): boolean {
  const fill = style?.fill
  if (typeof fill === 'string' && (fill === 'none' || fill === 'transparent')) return false
  const opacity = style?.fillOpacity
  if (opacity !== undefined && Number(opacity) === 0) return false
  return true
}

export interface SvgSoupOptions {
  /** Target width in mm. Height follows from the source aspect ratio. */
  widthMm: number
  /** Extrusion depth in mm. */
  thickness: number
}

/**
 * Extruded triangle soup for parsed artwork, centred on the origin in X and Y and extruded
 * symmetrically about z = 0.
 *
 * Centred, not floored, for the same reason `buildTextSoup` is: this is added as a PART, placed by
 * one point relative to its host. The caller stands it on the bed itself when adding it as a
 * standalone object.
 *
 * Returns an empty array when the artwork has no fillable outlines, which the caller must treat as
 * "nothing to add" rather than as an empty part.
 */
export function buildSvgSoup(parsed: ParsedSvg, options: SvgSoupOptions): Float32Array {
  const pieces = buildSvgPieceSoups(parsed, options)
  if (pieces.length === 0) return new Float32Array(0)
  const total = pieces.reduce((sum, piece) => sum + piece.soup.length, 0)
  const soup = new Float32Array(total)
  let at = 0
  for (const piece of pieces) {
    soup.set(piece.soup, at)
    at += piece.soup.length
  }
  return soup
}

/** Wrap a raw triangle soup as geometry, so both piece kinds share the transform code below. */
function planarGeometry(soup: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(soup, 3))
  return geometry
}

/** One extruded piece, with the name its part will carry. */
export interface SvgPieceSoup {
  soup: Float32Array
  /** 1-based, in paint order, so the parts read in the order the artwork was drawn. */
  index: number
  /** Fraction of the whole artwork's area this piece's bounds cover, for spotting a background. */
  coverage: number
}

/**
 * Extrude each piece separately, in ONE shared coordinate frame.
 *
 * The frame is what matters: every piece is scaled by the same factor and centred on the WHOLE
 * artwork's centre, not on its own, so the pieces still line up when they are added as separate
 * parts. Centring each piece on itself would stack every shape of the logo on one spot.
 */
export function buildSvgPieceSoups(parsed: ParsedSvg, options: SvgSoupOptions): SvgPieceSoup[] {
  if (parsed.pieces.length === 0 || parsed.width <= 0) return []
  const scale = options.widthMm / parsed.width
  // The whole artwork's centre, measured once in source units and applied to every piece.
  //
  // STROKES COUNT. A stroke piece carries no `shapes` -- it arrives already tessellated -- so a
  // fills-only sweep here measured a different artwork from the one `parsed.width` scaled, and the
  // two disagreeing is exactly the offset the user sees. Stroke-only art left this box EMPTY, whose
  // centre is the origin, so it was not centred at all: it kept whatever position the viewBox gave
  // it, tens of millimetres from the drop point.
  const whole = emptyBox()
  const point = new THREE.Vector2()
  for (const piece of parsed.pieces) {
    for (const shape of piece.shapes) expandByShape(whole, shape)
    const stroked = piece.strokeTriangles
    if (!stroked) continue
    for (let i = 0; i < stroked.length; i += 3) {
      whole.expandByPoint(point.set(stroked[i]!, stroked[i + 1]!))
    }
  }
  const centre = whole.getCenter(new THREE.Vector2())
  const wholeArea = Math.max(1e-9, parsed.width * parsed.height)

  const out: SvgPieceSoup[] = []
  parsed.pieces.forEach((piece, index) => {
    // A stroked piece arrives already tessellated flat, so it is thickened rather than extruded from
    // outlines. Both then go through the SAME frame below, which is what keeps a drawing's fills and
    // its outlines registered with each other.
    const geometry = piece.strokeTriangles
      ? planarGeometry(extrudePlanarTriangles(piece.strokeTriangles, options.thickness))
      : new THREE.ExtrudeGeometry(piece.shapes, {
        depth: options.thickness,
        bevelEnabled: false,
        curveSegments: CURVE_SEGMENTS
      })
    // Shift into artwork-centred coordinates BEFORE scaling, so one scale factor serves both.
    geometry.translate(-centre.x, -centre.y, 0)
    // Scale in the plane only: the requested width is artwork size, and scaling Z with it would make
    // thickness depend on how large the drawing happens to be.
    geometry.scale(scale, scale, 1)
    // `ExtrudeGeometry` runs 0..thickness; the thickened stroke is already centred on zero.
    if (!piece.strokeTriangles) geometry.translate(0, 0, -options.thickness / 2)
    // Turn the artwork the right way up WITHOUT mirroring: a 180-degree turn about X negates Y (the
    // correction SVG needs) and Z (harmless, the extrusion is symmetric about zero) while preserving
    // orientation, so every face still points outward. See the module header.
    geometry.rotateX(Math.PI)

    const nonIndexed = geometry.toNonIndexed()
    const positions = nonIndexed.getAttribute('position')
    const soup = new Float32Array(positions.array.length)
    soup.set(positions.array as Float32Array)
    geometry.dispose()
    nonIndexed.dispose()
    if (soup.length > 0) {
      out.push({ soup, index: index + 1, coverage: (piece.width * piece.height) / wholeArea })
    }
  })
  return out
}

/** The millimetre height the artwork will occupy at `widthMm`, for the panel's readout. */
export function svgHeightMm(parsed: ParsedSvg, widthMm: number): number {
  if (parsed.width <= 0) return 0
  return (parsed.height / parsed.width) * widthMm
}

/**
 * Where the artwork's origin lands once one piece has been staged as an OBJECT.
 *
 * Staging as `object` re-centres a mesh's XY bounds on the origin and floors it to z = 0; staging as
 * `part` leaves it exactly as given. So when a multi-piece import makes one piece the object's body
 * and the rest its parts, the two live in DIFFERENT frames, and the parts need this shift to land
 * back where they were drawn.
 *
 * Getting it wrong is not subtle in the file and is nearly invisible on screen: the parts sit half
 * the artwork's thickness below the body (their tops flush with its middle), so from above the logo
 * still reads correctly while every mark is actually buried inside the backing plate.
 */
export function svgObjectFrameShift(bodySoup: Float32Array): { x: number; y: number; z: number } {
  if (bodySoup.length === 0) return { x: 0, y: 0, z: 0 }
  let minX = Infinity; let maxX = -Infinity
  let minY = Infinity; let maxY = -Infinity
  let minZ = Infinity
  for (let i = 0; i < bodySoup.length; i += 3) {
    minX = Math.min(minX, bodySoup[i]!); maxX = Math.max(maxX, bodySoup[i]!)
    minY = Math.min(minY, bodySoup[i + 1]!); maxY = Math.max(maxY, bodySoup[i + 1]!)
    minZ = Math.min(minZ, bodySoup[i + 2]!)
  }
  // Exactly the inverse of what `object` normalisation applies to the body.
  return { x: -(minX + maxX) / 2, y: -(minY + maxY) / 2, z: -minZ }
}

/**
 * How much of the artwork's own bounding box a piece must span to read as its backdrop.
 *
 * Deliberately high. A logo's largest MARK routinely covers half the artboard, so a lower bar
 * would drop the artwork and keep the background, which is the failure that matters here: a wrongly
 * kept background is one click to delete, a wrongly dropped mark looks like the tool lost part of
 * the file.
 */
const BACKGROUND_COVERAGE = 0.85

/**
 * The piece acting as the artwork's backdrop, if there is one.
 *
 * Exists because of what a backdrop costs downstream: the largest piece becomes the imported
 * OBJECT's body, and an object's body cannot be deleted -- only the whole object, parts and all. So
 * the one shape a person most wants rid of is the one shape they cannot remove, unless it is
 * identified before the import decides what the body is.
 *
 * Bounding box rather than filled area, on purpose: a backdrop is defined by REACH, and plenty of
 * real ones are a frame or a torn edge that inks well under half of what they span.
 *
 * Returns the piece's index, or null when nothing spans enough to qualify. A tie cannot happen: only
 * the single largest candidate is returned, so a tiled design keeps everything except its outermost
 * layer, and the rest stay deletable parts.
 */
export function detectSvgBackgroundPiece(parsed: ParsedSvg): number | null {
  if (parsed.pieces.length < 2 || parsed.width <= 0 || parsed.height <= 0) return null
  const whole = parsed.width * parsed.height
  let best: number | null = null
  let bestArea = 0
  parsed.pieces.forEach((piece, index) => {
    const area = piece.width * piece.height
    if (area / whole < BACKGROUND_COVERAGE || area <= bestArea) return
    best = index
    bestArea = area
  })
  return best
}

/**
 * Whether a path's style paints a stroke worth turning into geometry.
 *
 * A zero or missing width paints nothing; `none` is explicit. Everything else is a real ribbon.
 */
function strokeWidthOf(style: { stroke?: unknown; strokeWidth?: unknown } | undefined): number | null {
  const stroke = style?.stroke
  if (stroke == null || stroke === 'none' || stroke === 'transparent') return null
  const width = Number(style?.strokeWidth ?? 1)
  return Number.isFinite(width) && width > 0 ? width : null
}

/**
 * A stroked path as flat triangles, or null when it paints no stroke.
 *
 * Delegates the ribbon itself to the loader, which already handles joins, caps and the miter limit;
 * re-deriving that here would be a polygon-offset implementation and would disagree with how the
 * same file renders in a browser.
 */
function strokeTrianglesFor(path: { subPaths: THREE.Path[]; userData?: { style?: Record<string, unknown> } }): Float32Array | null {
  const style = path.userData?.style
  const width = strokeWidthOf(style)
  if (width == null) return null
  const strokeStyle = SVGLoader.getStrokeStyle(
    width,
    '#000000',
    typeof style?.strokeLineJoin === 'string' ? style.strokeLineJoin : 'miter',
    typeof style?.strokeLineCap === 'string' ? style.strokeLineCap : 'butt',
    Number(style?.strokeMiterLimit ?? 4)
  )
  const collected: number[] = []
  for (const subPath of path.subPaths) {
    const points = subPath.getPoints(CURVE_SEGMENTS)
    if (points.length < 2) continue
    const geometry = SVGLoader.pointsToStroke(points, strokeStyle)
    if (!geometry) continue
    const position = geometry.getAttribute('position')
    // `pointsToStroke` returns a non-indexed ribbon, so the positions ARE the triangles.
    for (let i = 0; i < position.array.length; i++) collected.push(position.array[i] as number)
    geometry.dispose()
  }
  return collected.length > 0 ? new Float32Array(collected) : null
}

/** Quantised edge key, so two triangles sharing an edge agree on it despite float noise. */
function edgeKey(ax: number, ay: number, bx: number, by: number): string {
  const a = `${Math.round(ax * 1e4)},${Math.round(ay * 1e4)}`
  const b = `${Math.round(bx * 1e4)},${Math.round(by * 1e4)}`
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * Re-triangulate so no vertex sits in the middle of another triangle's edge.
 *
 * T-JUNCTIONS are what this removes, and they are not an edge-counting quirk: they are a hole in the
 * SURFACE. `pointsToStroke` draws a round cap or join as a fan whose centre vertex lands ON the
 * ribbon's end edge, so the ribbon triangle spans an edge that the fan covers with two shorter ones
 * and shares with neither. The cap is already not a closed surface there, whatever the walls do.
 *
 * Counting raw edges, all three of those read as used once, i.e. as boundary, so the long one grew a
 * wall THROUGH the ribbon with material on both sides -- an internal partition the slicer prints.
 * Splitting the offending triangle instead makes the cap conform, after which the ordinary
 * "used once" rule is exactly right and the solid closes.
 *
 * One split per pass, re-examining the pieces, because a triangle can carry several T-junctions and
 * each split can expose the next. Every split point is an EXISTING vertex, so the vertex set never
 * grows and the pass terminates.
 */
function conformTriangles(triangles: Float32Array): Float32Array {
  if (triangles.length === 0) return triangles
  // Every distinct corner, bucketed by cell so a triangle only tests the vertices near it. Without
  // the grid this is every vertex against every edge, which on real artwork is millions of tests.
  let extent = 0
  for (let i = 0; i < triangles.length; i += 3) {
    extent = Math.max(extent, Math.abs(triangles[i]!), Math.abs(triangles[i + 1]!))
  }
  const cellSize = extent > 0 ? extent / 128 : 1
  const cells = new Map<string, Array<readonly [number, number]>>()
  const seen = new Set<string>()
  for (let i = 0; i < triangles.length; i += 3) {
    const x = triangles[i]!
    const y = triangles[i + 1]!
    const vertex = `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`
    if (seen.has(vertex)) continue
    seen.add(vertex)
    const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`
    let bucket = cells.get(key)
    if (!bucket) { bucket = []; cells.set(key, bucket) }
    bucket.push([x, y])
  }

  /** The vertex sitting on `p`->`q`, nearest to `p`, or null when the edge is clean. */
  const splitPoint = (ax: number, ay: number, bx: number, by: number): readonly [number, number] | null => {
    const dx = bx - ax
    const dy = by - ay
    const length2 = dx * dx + dy * dy
    if (length2 === 0) return null
    let best: readonly [number, number] | null = null
    let bestT = Infinity
    const minX = Math.floor(Math.min(ax, bx) / cellSize) - 1
    const maxX = Math.floor(Math.max(ax, bx) / cellSize) + 1
    const minY = Math.floor(Math.min(ay, by) / cellSize) - 1
    const maxY = Math.floor(Math.max(ay, by) / cellSize) + 1
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        for (const [vx, vy] of cells.get(`${cx},${cy}`) ?? []) {
          // Strictly between the ends, measured in the segment's own parameter so the margin scales
          // with the edge rather than assuming artwork units...
          const t = ((vx - ax) * dx + (vy - ay) * dy) / length2
          if (!(t > 1e-9 && t < 1 - 1e-9) || t >= bestT) continue
          // ...and ON it, or a vertex merely near the edge would split it and invent geometry.
          const offsetX = ax + t * dx - vx
          const offsetY = ay + t * dy - vy
          if (offsetX * offsetX + offsetY * offsetY > 1e-10) continue
          bestT = t
          best = [vx, vy]
        }
      }
    }
    return best
  }

  const out: number[] = []
  const pending: number[][] = []
  for (let i = 0; i < triangles.length; i += 9) {
    pending.push([
      triangles[i]!, triangles[i + 1]!,
      triangles[i + 3]!, triangles[i + 4]!,
      triangles[i + 6]!, triangles[i + 7]!
    ])
  }
  // A split replaces one triangle with two, so the work is bounded by the number of T-junctions.
  // The cap is a backstop against a pathological input rather than an expected limit.
  const limit = pending.length * 64 + 1024
  let processed = 0
  while (pending.length > 0 && processed < limit) {
    processed += 1
    const [ax, ay, bx, by, cx, cy] = pending.pop() as [number, number, number, number, number, number]
    const corners = [[ax, ay], [bx, by], [cx, cy]] as const
    let split: { edge: number; point: readonly [number, number] } | null = null
    for (let e = 0; e < 3 && !split; e++) {
      const [px, py] = corners[e]!
      const [qx, qy] = corners[(e + 1) % 3]!
      const point = splitPoint(px, py, qx, qy)
      if (point) split = { edge: e, point }
    }
    if (!split) {
      out.push(ax, ay, bx, by, cx, cy)
      continue
    }
    // Fan from the corner OPPOSITE the split edge, which keeps both halves wound as the original was.
    const [px, py] = corners[split.edge]!
    const [qx, qy] = corners[(split.edge + 1) % 3]!
    const [rx, ry] = corners[(split.edge + 2) % 3]!
    const [sx, sy] = split.point
    pending.push([px, py, sx, sy, rx, ry])
    pending.push([sx, sy, qx, qy, rx, ry])
  }
  // Anything still pending on the backstop is emitted unsplit: a worse solid than a conformed one,
  // but the same one this produced before, rather than dropped geometry.
  for (const [ax, ay, bx, by, cx, cy] of pending) out.push(ax!, ay!, bx!, by!, cx!, cy!)

  const conformed = new Float32Array(out.length / 6 * 9)
  for (let t = 0; t < out.length / 6; t++) {
    for (let corner = 0; corner < 3; corner++) {
      conformed[t * 9 + corner * 3] = out[t * 6 + corner * 2]!
      conformed[t * 9 + corner * 3 + 1] = out[t * 6 + corner * 2 + 1]!
    }
  }
  return conformed
}

export function extrudePlanarTriangles(source: Float32Array, thickness: number): Float32Array {
  if (source.length === 0) return new Float32Array(0)
  // Conform FIRST. Boundary detection is "an edge used by exactly one triangle", which is only a
  // meaningful question once no vertex sits in the middle of another triangle's edge.
  const triangles = conformTriangles(source)
  const half = thickness / 2
  const out: number[] = []
  const edgeUse = new Map<string, number>()

  for (let i = 0; i < triangles.length; i += 9) {
    const ax = triangles[i]!, ay = triangles[i + 1]!
    const bx = triangles[i + 3]!, by = triangles[i + 4]!
    const cx = triangles[i + 6]!, cy = triangles[i + 7]!
    // Skip degenerate triangles: they contribute no surface and would leave phantom boundary edges.
    if (Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) < 1e-9) continue
    // Top cap keeps the source winding; the bottom is reversed so it faces the other way.
    out.push(ax, ay, half, bx, by, half, cx, cy, half)
    out.push(ax, ay, -half, cx, cy, -half, bx, by, -half)
    for (const [p, q] of [[[ax, ay], [bx, by]], [[bx, by], [cx, cy]], [[cx, cy], [ax, ay]]] as const) {
      const key = edgeKey(p[0], p[1], q[0], q[1])
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1)
    }
  }

  for (let i = 0; i < triangles.length; i += 9) {
    const v = [
      [triangles[i]!, triangles[i + 1]!],
      [triangles[i + 3]!, triangles[i + 4]!],
      [triangles[i + 6]!, triangles[i + 7]!]
    ] as const
    for (let e = 0; e < 3; e++) {
      const [px, py] = v[e]!
      const [qx, qy] = v[(e + 1) % 3]!
      if ((edgeUse.get(edgeKey(px, py, qx, qy)) ?? 0) !== 1) continue
      // Wound to match the caps: walking the boundary in the top cap's direction, the wall's outward
      // face follows from taking the edge bottom-first.
      out.push(px, py, -half, qx, qy, -half, qx, qy, half)
      out.push(px, py, -half, qx, qy, half, px, py, half)
    }
  }
  return new Float32Array(out)
}
