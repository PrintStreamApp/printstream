/**
 * SVG artwork becoming printable triangles.
 *
 * The interesting cases are all things that look fine on a symmetric test shape and are wrong on
 * real artwork: a mirrored drawing, a drawing scaled by whatever units the file happened to use, and
 * a stroke-only file that silently adds an empty part.
 */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../../../test-utils/jsdom'

let dom: JSDOM
let parseSvgShapes: typeof import('./svgGeometry').parseSvgShapes
let buildSvgSoup: typeof import('./svgGeometry').buildSvgSoup
let svgHeightMm: typeof import('./svgGeometry').svgHeightMm
let buildSvgPieceSoups: typeof import('./svgGeometry').buildSvgPieceSoups
let svgObjectFrameShift: typeof import('./svgGeometry').svgObjectFrameShift
let detectSvgBackgroundPiece: typeof import('./svgGeometry').detectSvgBackgroundPiece

before(async () => {
  // The loader parses markup with `DOMParser`, so the DOM has to exist before the module loads.
  // `installJsdomGlobals` deliberately ships a core set and leaves extras to the caller, and this is
  // the first suite to need this one.
  dom = installJsdomGlobals()
  Object.assign(globalThis, { DOMParser: dom.window.DOMParser })
  const mod = await import('./svgGeometry')
  parseSvgShapes = mod.parseSvgShapes
  buildSvgSoup = mod.buildSvgSoup
  svgHeightMm = mod.svgHeightMm
  buildSvgPieceSoups = mod.buildSvgPieceSoups
  svgObjectFrameShift = mod.svgObjectFrameShift
  detectSvgBackgroundPiece = mod.detectSvgBackgroundPiece
})

after(() => {
  dom.window.close()
})

/** An L: asymmetric in BOTH axes, which is the only way a mirror is visible. */
const L_SHAPE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 10 L 30 10 L 30 70 L 90 70 L 90 90 L 10 90 Z" fill="black"/>
</svg>`

const SQUARE_WITH_HOLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 0 0 H 100 V 100 H 0 Z M 25 25 V 75 H 75 V 25 Z" fill="black"/>
</svg>`

const STROKE_ONLY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 10 L 90 90" stroke="black" fill="none"/>
</svg>`

function bounds(soup: Float32Array) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < soup.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, soup[i + axis]!)
      max[axis] = Math.max(max[axis]!, soup[i + axis]!)
    }
  }
  return { min, max }
}

test('artwork is not mirrored: SVG Y points down, the model Y points up', () => {
  // THE trap. Extruding the loader's output as-is flips the drawing, which is invisible on a
  // symmetric logo and obvious on anything with lettering in it. The L's foot is at the BOTTOM in
  // the source (large SVG y), so after the flip its long edge must sit at low model y.
  const parsed = parseSvgShapes(L_SHAPE)
  assert.ok(parsed.pieces.length > 0, 'the L produced no fillable outline')
  const soup = buildSvgSoup(parsed, { widthMm: 80, thickness: 2 })
  const { min, max } = bounds(soup)

  // Width of the artwork at each end of Y, measured from the triangles themselves.
  const spanAt = (lowY: number, highY: number) => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < soup.length; i += 3) {
      const y = soup[i + 1]!
      if (y >= lowY && y <= highY) {
        lo = Math.min(lo, soup[i]!)
        hi = Math.max(hi, soup[i]!)
      }
    }
    return hi - lo
  }
  const height = max[1]! - min[1]!
  const bottomSpan = spanAt(min[1]!, min[1]! + height * 0.1)
  const topSpan = spanAt(max[1]! - height * 0.1, max[1]!)
  assert.ok(bottomSpan > topSpan * 2,
    `the L is upside down: bottom span ${bottomSpan.toFixed(1)} vs top ${topSpan.toFixed(1)}`)
})

test('the artwork is scaled to the requested width in mm, whatever units the file used', () => {
  const parsed = parseSvgShapes(L_SHAPE)
  const soup = buildSvgSoup(parsed, { widthMm: 40, thickness: 2 })
  const { min, max } = bounds(soup)
  assert.ok(Math.abs((max[0]! - min[0]!) - 40) < 0.01, 'width should be exactly what was asked for')
})

test('thickness is independent of artwork size', () => {
  // Scaling Z with the plane would make a big logo thick and a small one paper-thin.
  const parsed = parseSvgShapes(L_SHAPE)
  for (const widthMm of [10, 200]) {
    const { min, max } = bounds(buildSvgSoup(parsed, { widthMm, thickness: 3 }))
    assert.ok(Math.abs((max[2]! - min[2]!) - 3) < 0.01, `thickness drifted at width ${widthMm}`)
  }
})

test('the soup is centred on the origin, because it is placed as a part', () => {
  const parsed = parseSvgShapes(L_SHAPE)
  const { min, max } = bounds(buildSvgSoup(parsed, { widthMm: 50, thickness: 2 }))
  for (const axis of [0, 1, 2]) {
    assert.ok(Math.abs(min[axis]! + max[axis]!) < 0.01, `axis ${axis} is not centred`)
  }
})

test('a hole in the artwork stays a hole', () => {
  // A square with a square counter: if the hole were extruded as a solid the part would be a plain
  // slab, so compare the triangle count against the same outline with no counter.
  const holed = parseSvgShapes(SQUARE_WITH_HOLE)
  const solid = parseSvgShapes(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <path d="M 0 0 H 100 V 100 H 0 Z" fill="black"/></svg>`)
  const holedSoup = buildSvgSoup(holed, { widthMm: 50, thickness: 2 })
  const solidSoup = buildSvgSoup(solid, { widthMm: 50, thickness: 2 })
  assert.ok(holedSoup.length > solidSoup.length,
    'the counter was filled in: a holed square must need more triangles than a plain one')
})

test('a stroke becomes a printable ribbon, as it does in Studio', () => {
  // A line drawing used to import as nothing at all. BambuStudio turns strokes into geometry
  // (`stroke_to_expolygons`, its own id per stroke), so a file drawn entirely in strokes is a
  // legitimate thing to print rather than an empty result.
  const parsed = parseSvgShapes(STROKE_ONLY)
  assert.equal(parsed.pieces.length, 1)
  assert.ok(buildSvgSoup(parsed, { widthMm: 50, thickness: 2 }).length > 0)
})

test('a path with BOTH a fill and a stroke yields both', () => {
  // They are different solids and Studio splits them the same way, so a filled shape with an outline
  // must not lose its outline to its fill.
  const parsed = parseSvgShapes(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <path d="M 20 20 H 80 V 80 H 20 Z" fill="black" stroke="black" stroke-width="4"/></svg>`)
  assert.equal(parsed.pieces.length, 2)
  assert.ok(parsed.pieces[0]!.shapes.length > 0, 'the fill should be outlines')
  assert.ok(parsed.pieces[1]!.strokeTriangles != null, 'the stroke should be tessellated triangles')
})

test('a path with no paint at all yields nothing', () => {
  // The contract the caller relies on to tell "nothing to add" from "a part with no triangles",
  // which would otherwise reach the 3MF as an empty volume.
  const parsed = parseSvgShapes(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <path d="M 10 10 L 90 90" fill="none" stroke="none"/></svg>`)
  assert.equal(parsed.pieces.length, 0)
  assert.equal(buildSvgSoup(parsed, { widthMm: 50, thickness: 2 }).length, 0)
})

test('a thickened stroke is a CLOSED solid, walled only on its boundary', () => {
  // Two things at once. Signed volume proves it is closed and wound outward -- an open shell or a
  // reversed one would not be printable. And the wall count proves interior edges were skipped:
  // walling every edge instead of only the boundary would fill the ribbon with internal partitions,
  // which is watertight enough to fool a volume check while slicing as a stack of walls.
  const parsed = parseSvgShapes(STROKE_ONLY)
  const soup = buildSvgSoup(parsed, { widthMm: 60, thickness: 3 })
  let volume = 0
  for (let i = 0; i < soup.length; i += 9) {
    const ax = soup[i]!, ay = soup[i + 1]!, az = soup[i + 2]!
    const bx = soup[i + 3]!, by = soup[i + 4]!, bz = soup[i + 5]!
    const cx = soup[i + 6]!, cy = soup[i + 7]!, cz = soup[i + 8]!
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  assert.ok(volume > 0, `the stroke solid is open or inside-out: signed volume ${volume.toFixed(2)}`)

  // A simple ribbon has far fewer boundary edges than edges overall, so walls are a minority of it.
  const triangles = soup.length / 9
  const walls = soup.length === 0 ? 0 : triangles - (parsed.pieces[0]!.strokeTriangles!.length / 9) * 2
  assert.ok(walls > 0, 'no walls were emitted, so the solid has no sides')
  assert.ok(walls < triangles * 0.75, `every edge appears walled (${walls} of ${triangles})`)
})

test('the height readout follows the source aspect', () => {
  // The panel shows the height the user is about to get; a square source at 60mm wide is 60 tall.
  const parsed = parseSvgShapes(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20">
    <path d="M 0 0 H 10 V 20 H 0 Z" fill="black"/></svg>`)
  assert.ok(Math.abs(svgHeightMm(parsed, 30) - 60) < 0.01)
})

test('empty markup is reported as nothing, not as a crash', () => {
  const parsed = parseSvgShapes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  assert.equal(parsed.pieces.length, 0)
  assert.equal(buildSvgSoup(parsed, { widthMm: 50, thickness: 2 }).length, 0)
  assert.equal(svgHeightMm(parsed, 30), 0)
})

/** A background rectangle behind two separate marks: the shape real logos take. */
const LOGO_WITH_BACKGROUND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="100" height="100" fill="#fff"/>
  <path d="M 10 10 H 40 V 40 H 10 Z" fill="black"/>
  <path d="M 60 60 H 90 V 90 H 60 Z" fill="black"/>
</svg>`

test('each source element stays its own piece', () => {
  // The unit a person drew is the unit they get back: a background they can delete, and marks they
  // can give their own filament. Merged into one soup, neither is addressable.
  const parsed = parseSvgShapes(LOGO_WITH_BACKGROUND)
  assert.equal(parsed.pieces.length, 3)
})

test('pieces are extruded in ONE frame, so they still line up', () => {
  // THE trap in splitting: centring each piece on its own centre stacks every mark of the logo on
  // the same spot. The two marks sit in opposite corners and must stay there.
  const parsed = parseSvgShapes(LOGO_WITH_BACKGROUND)
  const pieces = buildSvgPieceSoups(parsed, { widthMm: 100, thickness: 2 })
  assert.equal(pieces.length, 3)
  const centreOf = (soup: Float32Array) => {
    let x = 0
    let y = 0
    for (let i = 0; i < soup.length; i += 3) { x += soup[i]!; y += soup[i + 1]! }
    return { x: x / (soup.length / 3), y: y / (soup.length / 3) }
  }
  const first = centreOf(pieces[1]!.soup)
  const second = centreOf(pieces[2]!.soup)
  assert.ok(first.x < -5 && second.x > 5, `marks collapsed together: ${first.x} vs ${second.x}`)
  // Opposite corners in Y too, and the right way up: the first mark is at the TOP in the source.
  assert.ok(first.y > 5 && second.y < -5, `marks not in opposite corners: ${first.y} vs ${second.y}`)
})

test('a full-bleed background is reported by its coverage', () => {
  // What lets the caller flag "this piece is the artboard" without guessing from names.
  const parsed = parseSvgShapes(LOGO_WITH_BACKGROUND)
  const pieces = buildSvgPieceSoups(parsed, { widthMm: 100, thickness: 2 })
  assert.ok(pieces[0]!.coverage > 0.9, 'the background should cover nearly the whole artwork')
  assert.ok(pieces[1]!.coverage < 0.2, 'a mark should not')
})

test('the combined soup is every piece together', () => {
  const parsed = parseSvgShapes(LOGO_WITH_BACKGROUND)
  const pieces = buildSvgPieceSoups(parsed, { widthMm: 100, thickness: 2 })
  const combined = buildSvgSoup(parsed, { widthMm: 100, thickness: 2 })
  assert.equal(combined.length, pieces.reduce((sum, piece) => sum + piece.soup.length, 0))
})

test('parts are shifted into the frame the object body was normalised into', () => {
  // Staging as `object` re-centres XY and floors Z; staging as `part` does neither. Without this
  // shift every mark sits half the thickness BELOW the backing plate -- tops flush with its middle,
  // so from above the logo looks right while the marks are buried inside it.
  const parsed = parseSvgShapes(LOGO_WITH_BACKGROUND)
  const pieces = buildSvgPieceSoups(parsed, { widthMm: 100, thickness: 2 })
  const body = pieces[0]!   // the background: largest coverage
  const shift = svgObjectFrameShift(body.soup)
  // The body is centred on the artwork and spans -1..+1 in Z, so only Z moves, by half the thickness.
  assert.ok(Math.abs(shift.x) < 0.01, `x should not move: ${shift.x}`)
  assert.ok(Math.abs(shift.y) < 0.01, `y should not move: ${shift.y}`)
  assert.ok(Math.abs(shift.z - 1) < 0.01, `z should rise by half the thickness: ${shift.z}`)
})

test('an off-centre body shifts the parts in XY too', () => {
  // The body is whichever piece covers most, and that need not be centred on the artwork. A mark in
  // one corner as the body would otherwise drag every other piece away from where it was drawn.
  const parsed = parseSvgShapes(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <path d="M 0 0 H 20 V 20 H 0 Z" fill="black"/>
    <path d="M 80 80 H 100 V 100 H 80 Z" fill="black"/></svg>`)
  const pieces = buildSvgPieceSoups(parsed, { widthMm: 100, thickness: 2 })
  const shift = svgObjectFrameShift(pieces[0]!.soup)
  assert.ok(Math.abs(shift.x) > 10 && Math.abs(shift.y) > 10, `corner body should shift XY: ${JSON.stringify(shift)}`)
})

test('the solid is not inside-out', () => {
  // THE regression. The Y correction was first done by MIRRORING the shapes, and mirroring any
  // single axis reverses orientation, so every contour wound backwards and the extruded solid was
  // inside-out. On a real 12-path logo that measured 2596 inward side-wall normals against 1282
  // outward and rendered as a featureless slab; a simple fixture hides it, because an inside-out
  // slab still looks like a slab.
  //
  // Measured as SIGNED VOLUME (the divergence theorem) rather than by comparing normals to the
  // centroid: the L is concave, so its inner corner walls genuinely face toward the centre and a
  // centroid test calls a correct solid inside-out. Signed volume is positive for any closed mesh
  // wound outward, concave or not.
  const parsed = parseSvgShapes(L_SHAPE)
  const soup = buildSvgSoup(parsed, { widthMm: 60, thickness: 4 })
  let volume = 0
  for (let i = 0; i < soup.length; i += 9) {
    const ax = soup[i]!, ay = soup[i + 1]!, az = soup[i + 2]!
    const bx = soup[i + 3]!, by = soup[i + 4]!, bz = soup[i + 5]!
    const cx = soup[i + 6]!, cy = soup[i + 7]!, cz = soup[i + 8]!
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  assert.ok(volume > 0, `the solid is inside-out: signed volume ${volume.toFixed(1)}`)
  // Sanity that the instrument sees a real solid rather than a degenerate one: an L 60mm wide and
  // 4mm thick encloses a substantial volume.
  assert.ok(volume > 1000, `suspiciously small volume ${volume.toFixed(1)}`)
})

test('a backdrop that spans the artwork is detected', () => {
  // It has to be found BEFORE the import picks a body, because the body cannot be deleted later.
  const parsed = parseSvgShapes(LOGO_WITH_BACKGROUND)
  assert.equal(detectSvgBackgroundPiece(parsed), 0)
})

test('a large mark is not mistaken for a backdrop', () => {
  // The failure that matters: dropping artwork looks like the tool lost part of the file, while a
  // kept background is one click to delete. Two marks, the bigger covering well over half.
  const parsed = parseSvgShapes(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <path d="M 0 0 H 70 V 70 H 0 Z" fill="black"/>
    <path d="M 80 80 H 100 V 100 H 80 Z" fill="black"/></svg>`)
  assert.equal(detectSvgBackgroundPiece(parsed), null)
})

test('a single-piece drawing has no backdrop to drop', () => {
  // Otherwise the whole artwork would qualify and the import would come back empty.
  assert.equal(detectSvgBackgroundPiece(parseSvgShapes(L_SHAPE)), null)
})

/**
 * The shared frame must span the WHOLE artwork, strokes included.
 *
 * Every piece is centred on one frame so the marks stay registered with each other, and the scale
 * already comes from bounds that count strokes -- but the CENTRE was measured over fills only, and
 * a stroke piece carries no `shapes` at all. So stroke-only art centred on an empty box (the
 * origin, i.e. not centred at all) and mixed art centred on its fills, dragging every piece off the
 * drop point by however far the two centres differ.
 */
test('a stroke-only drawing is centred, not left wherever the viewBox put it', () => {
  const offset = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
    <path d="M 300 300 L 380 380" stroke="black" stroke-width="6" fill="none"/>
  </svg>`
  const soup = buildSvgSoup(parseSvgShapes(offset), { widthMm: 50, thickness: 2 })
  const { min, max } = bounds(soup)
  const centreX = (min[0]! + max[0]!) / 2
  const centreY = (min[1]! + max[1]!) / 2
  assert.ok(Math.abs(centreX) < 1, `stroke art is off-centre in x by ${centreX.toFixed(1)}mm`)
  assert.ok(Math.abs(centreY) < 1, `stroke art is off-centre in y by ${centreY.toFixed(1)}mm`)
})

test('mixed fill and stroke share one frame centred on both', () => {
  // The fill sits in one corner and the stroke in the other, so a frame measured over fills alone
  // puts the combined artwork visibly off the origin.
  const mixed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <path d="M 0 0 H 20 V 20 H 0 Z" fill="black"/>
    <path d="M 80 80 L 100 100" stroke="black" stroke-width="4" fill="none"/>
  </svg>`
  const soup = buildSvgSoup(parseSvgShapes(mixed), { widthMm: 100, thickness: 2 })
  const { min, max } = bounds(soup)
  const centreX = (min[0]! + max[0]!) / 2
  const centreY = (min[1]! + max[1]!) / 2
  assert.ok(Math.abs(centreX) < 1, `combined artwork is off-centre in x by ${centreX.toFixed(1)}mm`)
  assert.ok(Math.abs(centreY) < 1, `combined artwork is off-centre in y by ${centreY.toFixed(1)}mm`)
})

/** Every undirected edge and how many triangles use it. A closed solid uses each exactly twice. */
function edgeUsage(soup: Float32Array): Map<string, number> {
  const key = (i: number) => `${Math.round(soup[i]! * 1e4)},${Math.round(soup[i + 1]! * 1e4)},${Math.round(soup[i + 2]! * 1e4)}`
  const usage = new Map<string, number>()
  for (let i = 0; i < soup.length; i += 9) {
    const corners = [key(i), key(i + 3), key(i + 6)]
    for (let e = 0; e < 3; e++) {
      const a = corners[e]!
      const b = corners[(e + 1) % 3]!
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`
      usage.set(edge, (usage.get(edge) ?? 0) + 1)
    }
  }
  return usage
}

/**
 * A ROUND cap or join must not grow walls through the middle of the ribbon.
 *
 * `pointsToStroke` emits a round cap as a fan whose centre vertex sits ON the ribbon's end edge, a
 * T-junction. Counting raw edge usage, all three of those sub-edges are used exactly once, so a
 * boundary test that only asks "used once?" walls all three -- including the long one that the two
 * short ones already cover, which puts a wall INSIDE the solid with material on both sides.
 *
 * Signed volume cannot see this (the coincident walls cancel), which is why the measure here is
 * manifoldness: an internal partition is an edge shared by four triangles instead of two.
 */
test('round caps and joins do not grow internal partition walls', () => {
  const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <path d="M 10 50 L 90 50" stroke="black" stroke-width="10" fill="none"
      stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
  const soup = buildSvgSoup(parseSvgShapes(rounded), { widthMm: 100, thickness: 2 })
  const overused = [...edgeUsage(soup).values()].filter((count) => count > 2).length
  assert.equal(overused, 0, `${overused} edges are shared by more than two triangles (internal walls)`)
})

test('a round-joined polyline is closed, like its butt-capped equivalent', () => {
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
    <path d="M20 6 9 17l-5-5" stroke="black" stroke-width="2" fill="none"
      stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
  const soup = buildSvgSoup(parseSvgShapes(icon), { widthMm: 40, thickness: 2 })
  const counts = [...edgeUsage(soup).values()]
  assert.equal(counts.filter((count) => count > 2).length, 0, 'internal partitions inside the ribbon')
  assert.equal(counts.filter((count) => count !== 2).length, 0, 'the ribbon is not a closed solid')
})
