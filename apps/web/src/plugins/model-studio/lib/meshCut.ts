/**
 * Plane cut for editor objects (the editor's Cut tool, #28).
 *
 * Pure geometry: a world-space triangle soup is cut by a horizontal plane `z = cutZ` into an
 * upper and a lower half, and each open cross-section is capped (multiple loops and holes
 * supported) so both halves stay solid, sliceable meshes. The halves are serialized as binary
 * STL and staged through the editor's existing foreign-import endpoint, so the backend bakes
 * them into the 3MF exactly like any imported model, no new API surface.
 *
 * Caps only form where the cross-section's boundary chains close; an unclosed chain (a hole in
 * a broken source mesh) is skipped rather than failing the cut.
 */
import * as THREE from 'three'
import { isAddedPartMesh, isViewportAidMesh } from '../editorGeometry'
import { healTriangleSoupTJunctions } from './meshTJunctions'

export interface CutHalves {
  /** Triangle soup (9 floats per triangle) at or above the plane. Empty when nothing is above. */
  upper: Float32Array
  /** Triangle soup at or below the plane. Empty when nothing is below. */
  lower: Float32Array
}

/**
 * What to do with a kept half's orientation after the cut, mirroring BambuStudio's per-half
 * "Keep orientation / Place on cut / Flip" radio (`GLGizmoAdvancedCut`'s
 * `m_keep_*` / `m_place_on_cut_*` / `m_rotate_*`).
 */
export type CutHalfOrientation = 'keep' | 'placeOnCut' | 'flip'

/**
 * Rotate a cut half's world-space soup so the requested face ends up on the bed.
 *
 * `placeOnCut` turns the piece so its CUT FACE points down, which is what makes a cut half
 * printable without supports; `flip` turns it upside down (Studio's `rotation_transform(PI *
 * UnitX())`). Studio composes this into the instance transform; we bake it into the soup instead,
 * because our halves are re-staged as fresh imports whose vertices already carry every world
 * transform, so there is no instance frame left to rotate (the same reason the cut itself works in
 * world space). The caller must apply the SAME rotation to any helper volume it carries onto the
 * half, or the volume detaches from the geometry it was drawn on.
 *
 * Which way is "down" follows from the cut: the upper half (the side above the plane) meets the
 * plane on its LOW side, so its cut face's outward normal is -axis, while the lower half's is
 * +axis. Every rotation here is a 90-degree multiple, so it is expressed as an exact coordinate
 * swap rather than trig: no floating-point dirt on a mesh that is about to be welded, and each one
 * is a proper rotation, so triangle winding (and therefore the outward normals) survives.
 */
export function orientCutHalfSoup(
  soup: Float32Array,
  axis: CutAxis,
  side: 'lower' | 'upper',
  orientation: CutHalfOrientation
): Float32Array {
  const rotate = cutHalfRotation(axis, side, orientation)
  if (!rotate) return soup
  for (let i = 0; i < soup.length; i += 3) {
    const [x, y, z] = rotate(soup[i]!, soup[i + 1]!, soup[i + 2]!)
    soup[i] = x
    soup[i + 1] = y
    soup[i + 2] = z
  }
  return soup
}

type SoupRotation = (x: number, y: number, z: number) => [number, number, number]

/** Exact 90-degree-multiple rotations; null means "already facing the right way". */
function cutHalfRotation(axis: CutAxis, side: 'lower' | 'upper', orientation: CutHalfOrientation): SoupRotation | null {
  // Upside down about X, whatever the cut axis was.
  if (orientation === 'flip') return (x, y, z) => [x, -y, -z]
  if (orientation === 'keep') return null
  if (axis === 'z') {
    // The upper half's cut face is already its underside, so placing it on the cut is a no-op.
    return side === 'upper' ? null : (x, y, z) => [x, -y, -z]
  }
  if (axis === 'x') {
    return side === 'upper'
      ? (x, y, z) => [-z, y, x] // -90 about Y: +X -> +Z, so the -X cut face turns down
      : (x, y, z) => [z, y, -x] // +90 about Y: +X -> -Z
  }
  return side === 'upper'
    ? (x, y, z) => [x, -z, y] // +90 about X: +Y -> +Z, so the -Y cut face turns down
    : (x, y, z) => [x, z, -y] // -90 about X: +Y -> -Z
}

/**
 * XY centre of a soup's bounding box: where a piece rebased from it should be placed.
 *
 * Read-only counterpart to {@link rebaseTriangleSoup}'s offset, for the caller that must decide a
 * ROTATED piece's placement. Once a half is reoriented, its rebased centre is expressed in the
 * rotated frame and is no longer a world position, so a piece placed there lands wherever the
 * rotation happened to send it (a tall model cut along X went off the plate entirely).
 */
export function triangleSoupXYCenter(soup: Float32Array): { x: number; y: number } {
  if (soup.length === 0) return { x: 0, y: 0 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < soup.length; i += 3) {
    minX = Math.min(minX, soup[i]!); maxX = Math.max(maxX, soup[i]!)
    minY = Math.min(minY, soup[i + 1]!); maxY = Math.max(maxY, soup[i + 1]!)
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/**
 * Whether two soups hold identical geometry, vertex for vertex in the same order.
 *
 * EXACT, deliberately: the callers use it to decide whether a rebuild produced the same mesh as the
 * last one, and both were produced by the same builder from the same inputs, so equal means bitwise
 * equal. A tolerance would be answering a different question (are these shapes alike?) and could
 * skip work after a real change. `NaN` never appears in a built soup, so `!==` is safe here.
 */
export function triangleSoupsEqual(a: Float32Array, b: Float32Array): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** Distance (mm) within which a vertex counts as lying on the cut plane. */
const PLANE_EPSILON = 1e-5
/**
 * How many float32 ULP from the plane still counts as ON it.
 *
 * The fixed 1e-5 above is only right near the origin. A soup is a `Float32Array`, whose precision is
 * RELATIVE: one ULP is ~6e-7 at coordinate 10, ~7.6e-6 at 100 and ~1.5e-5 at 200. So on a large or
 * plate-placed model a vertex can sit several ULP off the plane -- indistinguishable from lying on
 * it -- yet fail an absolute 1e-5 test, get clipped as though it genuinely crossed, and leave a
 * SLIVER triangle whose three edges pair with nothing. That is what made the dovetail's open-half
 * count rise with model size (46 at 20mm, 104 at 200mm), which is the signature of an absolute
 * tolerance competing with relative precision.
 */
const PLANE_EPSILON_ULPS = 4
/** Float32 carries a 24-bit mantissa, so its relative step is 2^-23. */
const FLOAT32_RELATIVE_STEP = 2 ** -23
/**
 * Floor (mm) and ULP budget for reading a face the cut ALREADY WROTE back off the plane.
 *
 * Deliberately looser than the pair above, because these vertices were written AT the plane and the
 * only spread left is float32 rounding at the model's own magnitude. Being looser is not a nicety:
 * it is the invariant that keeps the two tolerances consistent. Anything
 * {@link cutTriangleSoupAtZ} classified as on-plane must still read as on-plane here, or the drill
 * files that triangle into the body, its edges never reach the cap outline, and the rebuilt face is
 * either dropped or chained into a wrong loop -- with nothing thrown. `writtenPlaneToleranceAt` is
 * therefore >= `planeEpsilonAt` at every magnitude, which holds because both the floor and the ULP
 * budget here are the larger of the pair.
 */
const WRITTEN_PLANE_EPSILON = 1e-4
const WRITTEN_PLANE_EPSILON_ULPS = 8
/** Quantization (mm) used to match boundary-segment endpoints when chaining cap loops. */
const CHAIN_QUANTUM = 1e-4

/**
 * Largest coordinate magnitude across `soups`, floored at `|value|`.
 *
 * Every plane tolerance below is scaled on this rather than on the plane's own coordinate. Taking
 * it from `|value|` alone is the trap: a model sitting at a 256mm plate centre and cut at z = 10
 * gives the CUT a tolerance derived from 256 and the DRILL one derived from 10, and the drill's
 * then comes out tighter than the cut's however generous its constants look.
 */
function coordinateMagnitude(value: number, soups: readonly Float32Array[]): number {
  let magnitude = Math.abs(value)
  for (const soup of soups) {
    for (let i = 0; i < soup.length; i++) {
      const v = Math.abs(soup[i]!)
      if (v > magnitude) magnitude = v
    }
  }
  return magnitude
}

/**
 * How far off the plane a vertex may sit and still be CLASSIFIED as lying on it.
 *
 * Exported for the tests, which pin the invariant above by asserting a face this call accepts is
 * still recognised by the drill.
 */
export function planeEpsilonAt(magnitude: number): number {
  return Math.max(PLANE_EPSILON, magnitude * FLOAT32_RELATIVE_STEP * PLANE_EPSILON_ULPS)
}

/** How far off the plane a vertex the cut WROTE at the plane may sit and still be recognised. */
function writtenPlaneToleranceAt(magnitude: number): number {
  return Math.max(WRITTEN_PLANE_EPSILON, magnitude * FLOAT32_RELATIVE_STEP * WRITTEN_PLANE_EPSILON_ULPS)
}

/**
 * Collect the world-space triangle soup of every model mesh under `root`, skipping editor
 * decorations (face-hull overlays, paint-tint overlays, modifier meshes, prime towers) and
 * non-mesh helpers. Paint overlays are real meshes parented under the part mesh, so without
 * the skip a painted object's painted triangles would be collected twice.
 * `includeModifierVolumes` keeps helper volumes (negative/modifier/blocker/enforcer meshes)
 * in the soup: used when a specific part is exported deliberately, never for the solid
 * geometry walks (cut/split/assemble/whole-object export).
 * `skipAddedParts` walks the object's OWN body only, leaving out every volume added to it this
 * session. A boolean's body operand needs that distinction, because on an object whose `parts` list
 * is empty the body and the added volumes are siblings under one rotor, and a plain walk would put
 * an operand into its own opposing side.
 */
export function collectWorldTriangles(
  root: THREE.Object3D,
  options?: { includeModifierVolumes?: boolean; skipAddedParts?: boolean }
): Float32Array {
  root.updateWorldMatrix(true, true)
  const chunks: Float32Array[] = []
  let total = 0
  const vertex = new THREE.Vector3()
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    // Helper volumes are the one aid a caller can ask to KEEP (an explicit part export), so they
    // are tested separately from the rest.
    if (mesh.userData.isHelperVolume ? !options?.includeModifierVolumes : isViewportAidMesh(mesh)) return
    if (options?.skipAddedParts && isAddedPartMesh(mesh)) return
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position')
    if (!position) return
    const index = geometry.getIndex()
    const vertexCount = index ? index.count : position.count
    const out = new Float32Array(vertexCount * 3)
    for (let i = 0; i < vertexCount; i++) {
      const v = index ? index.getX(i) : i
      vertex.set(position.getX(v), position.getY(v), position.getZ(v)).applyMatrix4(mesh.matrixWorld)
      out[i * 3] = vertex.x; out[i * 3 + 1] = vertex.y; out[i * 3 + 2] = vertex.z
    }
    chunks.push(out)
    total += out.length
  })
  const soup = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) { soup.set(chunk, offset); offset += chunk.length }
  return soup
}

/** Axis a cut plane is perpendicular to. */
export type CutAxis = 'x' | 'y' | 'z'

/**
 * What the cut tool produces: a plain planar split, or BambuStudio's interlocking tongue and groove.
 * Studio's `CutMode` also carries `cutByLine`, which this tool does not offer.
 */
export type CutMode = 'plane' | 'dovetail'

/**
 * Cut a triangle soup with the plane `axis = value` and cap both cross-sections. `upper` is the
 * half on the positive side of the axis. Non-Z axes are handled by cyclically rotating the
 * coordinates into the Z frame (a proper rotation, so winding/normals are preserved), cutting,
 * and rotating back.
 */
export function cutTriangleSoup(soup: Float32Array, axis: CutAxis, value: number): CutHalves {
  if (axis === 'z') return cutTriangleSoupAtZ(soup, value)
  const { upper, lower } = cutTriangleSoupAtZ(cycleAxes(soup, axis === 'x' ? 1 : 2), value)
  const back = axis === 'x' ? 2 : 1
  return { upper: cycleAxes(upper, back), lower: cycleAxes(lower, back) }
}

/**
 * An arbitrarily oriented cut plane: a point on it, and the normal that defines which side is
 * `upper`.
 *
 * The axis-aligned cases are NOT expressed through this. They keep {@link cutTriangleSoup}'s
 * coordinate permutation, which is exact, while any other orientation needs a real rotation and
 * therefore carries float error. Folding the three common cases into the general one would give
 * every existing cut error it does not have today, on a mesh that is about to be welded (the same
 * reason `orientCutHalfSoup` writes its 90-degree turns as coordinate swaps rather than trig).
 * {@link cutTriangleSoupByPlane} routes back to the exact path whenever the normal is axis-aligned.
 */
export interface CutPlane {
  /** A point the plane passes through, world space. */
  origin: THREE.Vector3
  /** Plane normal; `upper` is the half it points into. Need not be unit length. */
  normal: THREE.Vector3
}

/** Below this the normal is treated as degenerate and the cut is refused. */
const MIN_NORMAL_LENGTH = 1e-9
/** How close a normal component must be to +/-1 for the plane to count as axis-aligned. */
const AXIS_ALIGNED_EPSILON = 1e-9

/**
 * Which axis-aligned cut a plane is equivalent to, or null when it is genuinely oblique.
 *
 * Exported for the tests, which assert that the common orientations still take the exact path: an
 * oblique-looking normal that is actually axis-aligned must not start accumulating float error.
 * A NEGATIVE axis normal matches too, reported as `flipped`, because it describes the same plane
 * and only exchanges which side is `upper` -- see the comment in the body for why refusing it sent
 * every dovetail-derived plane down the rotated path.
 */
export function axisAlignedCutFor(plane: CutPlane): { axis: CutAxis; value: number; flipped: boolean } | null {
  const n = plane.normal
  const length = Math.hypot(n.x, n.y, n.z)
  if (length < MIN_NORMAL_LENGTH) return null
  const x = n.x / length, y = n.y / length, z = n.z / length
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z)
  // A NEGATIVE axis direction is just as axis-aligned as a positive one; it only exchanges which
  // side is "upper". Matching `x - 1` alone missed that, and the miss was not academic: every plane
  // the dovetail derives from its groove frame comes out as something like (2.2e-16, 0, -1), so the
  // groove's own cuts fell through to the ROTATED path. That path round-trips every vertex through
  // a quaternion and back, which leaves the last bits (and the sign of zero) different from the
  // coordinates the neighbouring pieces kept -- and `isClosedSoup` compares vertices bit-exactly, so
  // the halves stopped pairing along faces that are geometrically identical. That was 47 of 558
  // groove configurations coming back open.
  if (ax > 1 - AXIS_ALIGNED_EPSILON && ay < AXIS_ALIGNED_EPSILON && az < AXIS_ALIGNED_EPSILON) {
    return { axis: 'x', value: plane.origin.x, flipped: x < 0 }
  }
  if (ay > 1 - AXIS_ALIGNED_EPSILON && ax < AXIS_ALIGNED_EPSILON && az < AXIS_ALIGNED_EPSILON) {
    return { axis: 'y', value: plane.origin.y, flipped: y < 0 }
  }
  if (az > 1 - AXIS_ALIGNED_EPSILON && ax < AXIS_ALIGNED_EPSILON && ay < AXIS_ALIGNED_EPSILON) {
    return { axis: 'z', value: plane.origin.z, flipped: z < 0 }
  }
  return null
}

/**
 * Cut a triangle soup with an arbitrarily oriented plane, capping both cross-sections.
 *
 * Generalises {@link cutTriangleSoup} the same way it already generalises Z to X and Y: bring the
 * plane into the Z frame, cut at Z, and take the halves back. The only difference is that the
 * transform is a rotation rather than a coordinate permutation, so `cutTriangleSoupAtZ` and the
 * capping below it are reached unchanged and need to know nothing about orientation.
 *
 * Needed by the dovetail cut, whose groove is seven planar cuts of which four are tilted by the flap
 * and groove angles (BambuStudio's `Cut::perform_with_groove`, `CutUtils.cpp:883-899`).
 *
 * A degenerate normal returns both halves EMPTY rather than throwing: the caller already has to
 * handle "nothing to keep" for a plane that misses the mesh, so a bad plane takes the same route
 * instead of a second one.
 *
 * KNOWN LIMIT, shared with the axis-aligned path and not introduced here: a plane lying EXACTLY
 * along mesh edges leaves vertices on the plane itself, and the cap cannot chain a closed loop
 * through those, so both halves come back with open edges. Measured on a 10mm box: an oblique plane
 * through two of its edges leaves 5 open edges per half but conserves volume exactly, while the
 * axis path cutting the same box at `z = 10` leaves 4 open edges AND loses a third of the volume.
 * Pinned by `meshCut.test.ts`. It matters for the dovetail, whose groove planes are placed at fixed
 * offsets from the cut and can therefore land on a feature by arithmetic rather than by chance;
 * nudging such a plane off the feature is the caller's call, not something to paper over here.
 */
export function cutTriangleSoupByPlane(soup: Float32Array, plane: CutPlane): CutHalves {
  const axisAligned = axisAlignedCutFor(plane)
  if (axisAligned) {
    // `upper` means the +normal side. For a negative axis normal that is the axis cut's LOWER half,
    // so the two are exchanged rather than the cut being re-derived.
    const halves = cutTriangleSoup(soup, axisAligned.axis, axisAligned.value)
    return axisAligned.flipped ? { upper: halves.lower, lower: halves.upper } : halves
  }

  const normal = plane.normal.clone()
  if (normal.lengthSq() < MIN_NORMAL_LENGTH * MIN_NORMAL_LENGTH) {
    return { upper: new Float32Array(0), lower: new Float32Array(0) }
  }
  normal.normalize()

  // Rotate the plane's normal onto +Z, so the cut runs in the frame `cutTriangleSoupAtZ` expects.
  // `setFromUnitVectors` handles the antiparallel case itself, which matters because a normal of
  // -Z is an ordinary way to ask for the halves the other way round.
  const toZ = new THREE.Quaternion().setFromUnitVectors(normal, UNIT_Z)
  const backFromZ = toZ.clone().invert()
  // The plane's offset along the rotated axis. Taken from the ROTATED origin rather than from
  // `origin.dot(normal)`: the cut compares against a z coordinate in the rotated frame, and the two
  // agree only because the rotation is rigid, so deriving it the same way the vertices are moved
  // keeps them consistent to the same rounding.
  const rotatedOrigin = plane.origin.clone().applyQuaternion(toZ)

  const { upper, lower } = cutTriangleSoupAtZ(rotateSoup(soup, toZ), rotatedOrigin.z)
  return { upper: rotateSoup(upper, backFromZ), lower: rotateSoup(lower, backFromZ) }
}

const UNIT_Z = new THREE.Vector3(0, 0, 1)

/** Apply a rotation to every vertex of a soup, returning a new array. */
function rotateSoup(soup: Float32Array, rotation: THREE.Quaternion): Float32Array {
  const out = new Float32Array(soup.length)
  const vertex = new THREE.Vector3()
  for (let i = 0; i < soup.length; i += 3) {
    vertex.set(soup[i]!, soup[i + 1]!, soup[i + 2]!).applyQuaternion(rotation)
    out[i] = vertex.x; out[i + 1] = vertex.y; out[i + 2] = vertex.z
  }
  return out
}

/**
 * Cyclically permute every vertex's coordinates `steps` times: one step maps (x,y,z) -> (y,z,x).
 * One step brings X into the Z slot; two steps bring Y into the Z slot. Returns a new array.
 */
function cycleAxes(soup: Float32Array, steps: 1 | 2): Float32Array {
  const out = new Float32Array(soup.length)
  for (let i = 0; i < soup.length; i += 3) {
    if (steps === 1) { out[i] = soup[i + 1]!; out[i + 1] = soup[i + 2]!; out[i + 2] = soup[i]! }
    else { out[i] = soup[i + 2]!; out[i + 1] = soup[i]!; out[i + 2] = soup[i + 1]! }
  }
  return out
}

/** Cut a triangle soup with the horizontal plane `z = cutZ` and cap both cross-sections. */
export function cutTriangleSoupAtZ(soup: Float32Array, cutZ: number): CutHalves {
  const upper: number[] = []
  const lower: number[] = []
  /** Boundary segments of the cross-section: [x1, y1, x2, y2] per crossing triangle. */
  const segments: number[] = []
  const triCount = Math.floor(soup.length / 9)
  /**
   * Edges lying exactly ON the plane, which the span test above can never see.
   *
   * A triangle with TWO vertices on the plane is wholly upper or wholly lower, so it records no
   * chord, yet its on-plane edge really is part of the cross-section's boundary. Miss those and the
   * boundary has gaps, the loop never closes, and `triangulateCrossSection` skips it by design, so
   * the cap silently vanishes and the half renders see-through. Measured on a real Tape Holder cut
   * at its own midpoint (the tool's DEFAULT position on any symmetric model): 107 vertices on the
   * plane across 83 triangles, and all 4034 boundary edges of both caps lost.
   *
   * Counted by parity rather than presence, because a "valley" edge that merely touches the plane
   * from one side has BOTH neighbours on that side and would otherwise be recorded twice and read as
   * boundary.
   *
   * Tallied PER HALF, which is what makes a coplanar face work. Each half needs a cap over the
   * region where its material meets the plane MINUS whatever a coplanar face already covers there,
   * and those two regions differ between the halves -- so one shared outline cannot describe both.
   * Parity over (that half's on-plane edges + the coplanar faces assigned to it) is exactly that
   * difference: an edge the face shares with the walls below reaches 2 and cancels, while the edge
   * where the face ABUTS the cut region reaches 1 and survives.
   *
   * Excluding coplanar edges outright was the previous rule and it was too blunt: on a slab carrying
   * a tower, the x = 5 edge belongs to the slab's coplanar top, so it vanished, the outline never
   * closed, and BOTH halves silently lost their cap. Volume cannot catch that -- a missing cap at
   * z = cutZ contributes exactly zero to the divergence integral.
   */
  type OnPlaneEdge = { count: number; x1: number; y1: number; x2: number; y2: number }
  const lowerOnPlane = new Map<string, OnPlaneEdge>()
  const upperOnPlane = new Map<string, OnPlaneEdge>()
  /**
   * Tally one on-plane edge for one half. Hoisted out of the triangle loop rather than closed over
   * per triangle: `grooveCutPieces` runs seven cuts over the whole soup, so a per-triangle closure is
   * millions of throwaway allocations on a dense model.
   */
  const countOnPlaneEdge = (
    tally: Map<string, OnPlaneEdge>,
    a: readonly [number, number, number],
    b: readonly [number, number, number]
  ): void => {
    const key = edgeKey(a[0], a[1], b[0], b[1])
    const seen = tally.get(key)
    if (seen) seen.count += 1
    else tally.set(key, { count: 1, x1: a[0], y1: a[1], x2: b[0], y2: b[1] })
  }
  /** Every on-plane edge of a triangle, for a face that lies wholly ON the plane. */
  const countCoplanarEdges = (tally: Map<string, OnPlaneEdge>, verts: ReadonlyArray<readonly [number, number, number]>): void => {
    for (let i = 0; i < 3; i++) countOnPlaneEdge(tally, verts[i]!, verts[(i + 1) % 3]!)
  }

  const edgeKey = (x1: number, y1: number, x2: number, y2: number): string => {
    const q = (v: number) => Math.round(v / CHAIN_QUANTUM)
    const a = `${q(x1)},${q(y1)}`, b = `${q(x2)},${q(y2)}`
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }

  // Scale-aware, taken from the coordinates actually present rather than from a guess about the
  // model. `cutZ` is included because the plane can sit beyond the mesh's own extent.
  const planeEpsilon = planeEpsilonAt(coordinateMagnitude(cutZ, [soup]))

  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const verts: Array<readonly [number, number, number]> = [
      [soup[o]!, soup[o + 1]!, soup[o + 2]!],
      [soup[o + 3]!, soup[o + 4]!, soup[o + 5]!],
      [soup[o + 6]!, soup[o + 7]!, soup[o + 8]!]
    ]
    const dist = verts.map((v) => v[2] - cutZ)
    if (dist.every((d) => Math.abs(d) <= planeEpsilon)) {
      // A face lying exactly ON the plane. It adds no volume, but it IS the closing face on
      // whichever side the solid sits, and dropping it punched a hole in that half: a box resting
      // on the cut plane lost its own base. Its winding says which side that is, since an outward
      // normal points AWAY from the material, so a downward-facing face bounds material above.
      //
      // Its edges are tallied into THAT HALF's outline rather than excluded outright. Excluding them
      // was the earlier rule and it was too blunt where a coplanar face ABUTS the cut region: an
      // L-shaped solid (a 10x10x10 slab carrying a 5x10x10 tower on half its top, cut at the
      // junction) lost the x=5 edge to the slab's coplanar top, so the outline never closed and BOTH
      // halves came back uncapped. Volume cannot reveal that -- a missing cap at z = cutZ
      // contributes exactly zero to the divergence integral, so the halves still measure 500 and
      // 1000 -- which is why `meshCut.test.ts` asserts closedness on that fixture, not volume.
      //
      // A single shared tally does not work either, and was tried: the resting box's coplanar rim
      // edges border nothing and grow a phantom loop. Which region still needs covering DIFFERS
      // between the halves, so each keeps its own tally and `outlineFor` builds its own outline.
      const nz = (verts[1]![0] - verts[0]![0]) * (verts[2]![1] - verts[0]![1])
        - (verts[1]![1] - verts[0]![1]) * (verts[2]![0] - verts[0]![0])
      // A zero-area sliver bounds nothing and is dropped, as before.
      if (nz < 0) { countCoplanarEdges(upperOnPlane, verts); pushTriangle(upper, verts[0]!, verts[1]!, verts[2]!) }
      else if (nz > 0) { countCoplanarEdges(lowerOnPlane, verts); pushTriangle(lower, verts[0]!, verts[1]!, verts[2]!) }
      continue
    }
    if (dist.every((d) => d >= -planeEpsilon)) {
      // Recorded for the UPPER outline, the mirror of the branch below. Omitting it is what left the
      // upper half with no way to bound its own cap where a coplanar face abuts the cut.
      for (let i = 0; i < 3; i++) {
        if (Math.abs(dist[i]!) > planeEpsilon || Math.abs(dist[(i + 1) % 3]!) > planeEpsilon) continue
        countOnPlaneEdge(upperOnPlane, verts[i]!, verts[(i + 1) % 3]!)
      }
      pushTriangle(upper, verts[0]!, verts[1]!, verts[2]!)
      continue
    }
    if (dist.every((d) => d <= planeEpsilon)) {
      for (let i = 0; i < 3; i++) {
        if (Math.abs(dist[i]!) > planeEpsilon || Math.abs(dist[(i + 1) % 3]!) > planeEpsilon) continue
        countOnPlaneEdge(lowerOnPlane, verts[i]!, verts[(i + 1) % 3]!)
      }
      pushTriangle(lower, verts[0]!, verts[1]!, verts[2]!)
      continue
    }

    // The triangle genuinely spans the plane: clip it into both halves (orientation preserved)
    // and record the chord where it crosses for cap building.
    const up: Array<readonly [number, number, number]> = []
    const lo: Array<readonly [number, number, number]> = []
    const cross: Array<readonly [number, number, number]> = []
    for (let i = 0; i < 3; i++) {
      const a = verts[i]!, b = verts[(i + 1) % 3]!
      const da = dist[i]!, db = dist[(i + 1) % 3]!
      if (Math.abs(da) <= planeEpsilon) {
        up.push(a); lo.push(a); cross.push(a)
      } else if (da > 0) up.push(a)
      else lo.push(a)
      if (Math.abs(da) > planeEpsilon && Math.abs(db) > planeEpsilon && (da > 0) !== (db > 0)) {
        const f = da / (da - db)
        const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, cutZ] as const
        up.push(p); lo.push(p); cross.push(p)
      }
    }
    pushFan(upper, up)
    pushFan(lower, lo)
    if (cross.length === 2) segments.push(cross[0]![0], cross[0]![1], cross[1]![0], cross[1]![1])
  }

  // The CHORDS are shared: where the surface genuinely crosses, both halves end at the same line.
  // Only the on-plane edges differ, so each half's outline is the chords plus its own odd edges.
  const outlineFor = (tally: Map<string, OnPlaneEdge>): number[] => {
    const outline = segments.slice()
    for (const edge of tally.values()) {
      // Even means material on both sides of the edge along the plane (a valley), bounding nothing.
      if (edge.count % 2 === 0) continue
      outline.push(edge.x1, edge.y1, edge.x2, edge.y2)
    }
    return outline
  }

  // Cap each closed cross-section loop, normal +Z on the lower half's top face and -Z on the upper
  // half's bottom face. Each half is capped from its OWN outline.
  for (const cap of triangulateCrossSection(outlineFor(lowerOnPlane))) {
    const [a, b, c] = cap
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    const ccw = area2 >= 0 ? [a, b, c] : [a, c, b]
    pushTriangle(lower, [ccw[0]!.x, ccw[0]!.y, cutZ], [ccw[1]!.x, ccw[1]!.y, cutZ], [ccw[2]!.x, ccw[2]!.y, cutZ])
  }
  for (const cap of triangulateCrossSection(outlineFor(upperOnPlane))) {
    const [a, b, c] = cap
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    const ccw = area2 >= 0 ? [a, b, c] : [a, c, b]
    pushTriangle(upper, [ccw[0]!.x, ccw[0]!.y, cutZ], [ccw[2]!.x, ccw[2]!.y, cutZ], [ccw[1]!.x, ccw[1]!.y, cutZ])
  }

  return { upper: new Float32Array(upper), lower: new Float32Array(lower) }
}

function pushTriangle(
  out: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number]
): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
}

/** Fan-triangulate a convex clipped polygon (3-4 vertices), preserving its winding. */
function pushFan(out: number[], polygon: Array<readonly [number, number, number]>): void {
  for (let i = 1; i + 1 < polygon.length; i++) pushTriangle(out, polygon[0]!, polygon[i]!, polygon[i + 1]!)
}

/** Chain boundary segments into closed 2D loops, group holes under their outers, triangulate. */
function triangulateCrossSection(segments: number[]): Array<[THREE.Vector2, THREE.Vector2, THREE.Vector2]> {
  const quantize = (x: number, y: number) => `${Math.round(x / CHAIN_QUANTUM)},${Math.round(y / CHAIN_QUANTUM)}`
  // Dedupe segments (a mesh edge lying exactly on the plane reports once per adjacent triangle).
  const segByKey = new Map<string, [number, number, number, number]>()
  for (let i = 0; i + 3 < segments.length; i += 4) {
    const a = quantize(segments[i]!, segments[i + 1]!)
    const b = quantize(segments[i + 2]!, segments[i + 3]!)
    if (a === b) continue
    segByKey.set(a < b ? `${a}|${b}` : `${b}|${a}`, [segments[i]!, segments[i + 1]!, segments[i + 2]!, segments[i + 3]!])
  }
  /**
   * ONE position per quantized corner, so every segment meeting there emits the same coordinates.
   *
   * The chainer matches endpoints at `CHAIN_QUANTUM` but each segment carries its own raw floats, so
   * two edges meeting at a corner contributed positions differing by a few float32 ULP -- and the
   * cap triangles inherited that. It does not show on a small model, where the arithmetic happens to
   * land identically, but at 100mm coordinates a float32 ULP is ~7.6e-6 and the corners came out up
   * to 5e-5 apart: still one point to the chainer, two points to `isClosedSoup`, which compares
   * vertices bit-exactly. The cut then produced halves that looked right, measured the right volume,
   * and were refused as boolean operands. Failures rose with model SIZE, which is the signature of a
   * tolerance that is absolute while the precision it competes with is relative.
   */
  const corners = new Map<string, THREE.Vector2>()
  const corner = (x: number, y: number): THREE.Vector2 => {
    const key = quantize(x, y)
    const existing = corners.get(key)
    if (existing) return existing
    const created = new THREE.Vector2(x, y)
    corners.set(key, created)
    return created
  }

  // Endpoint adjacency for chain walking.
  const adjacency = new Map<string, Array<{ segKey: string; point: THREE.Vector2; otherKey: string; other: THREE.Vector2 }>>()
  for (const [segKey, [x1, y1, x2, y2]] of segByKey) {
    const k1 = quantize(x1, y1), k2 = quantize(x2, y2)
    const p1 = corner(x1, y1), p2 = corner(x2, y2)
    if (!adjacency.has(k1)) adjacency.set(k1, [])
    if (!adjacency.has(k2)) adjacency.set(k2, [])
    adjacency.get(k1)!.push({ segKey, point: p1, otherKey: k2, other: p2 })
    adjacency.get(k2)!.push({ segKey, point: p2, otherKey: k1, other: p1 })
  }

  const usedSegs = new Set<string>()
  const loops: THREE.Vector2[][] = []
  for (const [segKey, [x1, y1, x2, y2]] of segByKey) {
    if (usedSegs.has(segKey)) continue
    usedSegs.add(segKey)
    const startKey = quantize(x1, y1)
    let currentKey = quantize(x2, y2)
    const loop: THREE.Vector2[] = [new THREE.Vector2(x1, y1), new THREE.Vector2(x2, y2)]
    let closed = false
    // Walk endpoint-to-endpoint until back at the start or stuck (open chain -> no cap).
    for (let guard = 0; guard < segByKey.size; guard++) {
      const next = (adjacency.get(currentKey) ?? []).find((entry) => !usedSegs.has(entry.segKey))
      if (!next) break
      usedSegs.add(next.segKey)
      currentKey = next.otherKey
      if (currentKey === startKey) { closed = true; break }
      loop.push(next.other)
    }
    if (closed && loop.length >= 3) loops.push(loop)
  }
  if (loops.length === 0) return []

  // Even containment depth = outer contour, odd = hole assigned to its smallest containing outer.
  const depths = loops.map((loop, i) =>
    loops.reduce((depth, other, j) => (j !== i && pointInLoop(loop[0]!, other) ? depth + 1 : depth), 0))
  const caps: Array<[THREE.Vector2, THREE.Vector2, THREE.Vector2]> = []
  loops.forEach((outer, i) => {
    if (depths[i]! % 2 !== 0) return
    const holes = loops.filter((hole, j) =>
      j !== i && depths[j]! % 2 === 1 && depths[j]! === depths[i]! + 1 && pointInLoop(hole[0]!, outer))
    const points = [...outer, ...holes.flat()]
    for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes)) {
      caps.push([points[tri[0]!]!, points[tri[1]!]!, points[tri[2]!]!])
    }
  })
  return caps
}

/** Even-odd point-in-polygon test in the cut plane. */
function pointInLoop(point: THREE.Vector2, loop: THREE.Vector2[]): boolean {
  let inside = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i]!, b = loop[j]!
    if ((a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * Translate a soup so its XY bounding-box centre sits at the origin and its lowest point at
 * z = 0 (the editor's natural pivot), returning the removed offset so the caller can place the
 * new instance exactly where the geometry came from.
 */
export function rebaseTriangleSoup(soup: Float32Array): { offset: { x: number; y: number; z: number } } {
  if (soup.length === 0) return { offset: { x: 0, y: 0, z: 0 } }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < soup.length; i += 3) {
    minX = Math.min(minX, soup[i]!); maxX = Math.max(maxX, soup[i]!)
    minY = Math.min(minY, soup[i + 1]!); maxY = Math.max(maxY, soup[i + 1]!)
    minZ = Math.min(minZ, soup[i + 2]!)
  }
  const offset = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: minZ }
  for (let i = 0; i < soup.length; i += 3) {
    soup[i] = soup[i]! - offset.x
    soup[i + 1] = soup[i + 1]! - offset.y
    soup[i + 2] = soup[i + 2]! - offset.z
  }
  return { offset }
}

/**
 * Which side(s) of an axis-aligned cut a HELPER volume belongs to.
 *
 * BambuStudio's rule verbatim (`ModelObject::process_modifier_cut`, Model.cpp): a modifier /
 * negative / blocker volume is **never geometrically cut**, it is assigned by its bounding box in
 * the cut plane's frame, and one that STRADDLES the plane is carried onto BOTH halves so each piece
 * keeps the region it needs. Our cut is axis-aligned, so the plane's frame is just `axis` vs
 * `offset` where BambuStudio uses z vs 0.
 *
 * An empty soup belongs to neither side rather than to both: carrying a volume with no geometry
 * would put an invisible part on every piece.
 */
export function helperVolumeCutSides(
  soup: Float32Array,
  axis: CutAxis,
  offset: number
): { lower: boolean; upper: boolean } {
  const component = axis === 'x' ? 0 : axis === 'y' ? 1 : 2
  let min = Infinity
  let max = -Infinity
  for (let i = component; i < soup.length; i += 3) {
    const value = soup[i]!
    if (value < min) min = value
    if (value > max) max = value
  }
  if (min === Infinity) return { lower: false, upper: false }
  const straddles = min <= offset && max >= offset
  return { lower: max <= offset || straddles, upper: min >= offset || straddles }
}

/** Shift a triangle soup by `-offset`, in place: the half's rebase applied to a carried volume. */
export function shiftTriangleSoup(soup: Float32Array, offset: { x: number; y: number; z: number }): Float32Array {
  for (let i = 0; i < soup.length; i += 3) {
    soup[i] = soup[i]! - offset.x
    soup[i + 1] = soup[i + 1]! - offset.y
    soup[i + 2] = soup[i + 2]! - offset.z
  }
  return soup
}

/** Serialize a triangle soup as a binary STL (the staged-import upload format). */
export function triangleSoupToBinaryStl(soup: Float32Array): ArrayBuffer {
  const triCount = Math.floor(soup.length / 9)
  const buffer = new ArrayBuffer(84 + triCount * 50)
  const view = new DataView(buffer)
  view.setUint32(80, triCount, true)
  let offset = 84
  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const ux = soup[o + 3]! - soup[o]!, uy = soup[o + 4]! - soup[o + 1]!, uz = soup[o + 5]! - soup[o + 2]!
    const vx = soup[o + 6]! - soup[o]!, vy = soup[o + 7]! - soup[o + 1]!, vz = soup[o + 8]! - soup[o + 2]!
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) { nx /= len; ny /= len; nz /= len } else { nx = 0; ny = 0; nz = 1 }
    view.setFloat32(offset, nx, true); view.setFloat32(offset + 4, ny, true); view.setFloat32(offset + 8, nz, true)
    offset += 12
    for (let i = 0; i < 9; i++) { view.setFloat32(offset, soup[o + i]!, true); offset += 4 }
    view.setUint16(offset, 0, true)
    offset += 2
  }
  return buffer
}

/**
 * Split a triangle soup into its connected components (Bambu's "split to objects"):
 * triangles that share a vertex position belong to the same component. Components
 * come back largest-first. A watertight single shell returns one entry.
 */
export function splitTriangleSoup(soup: Float32Array): Float32Array[] {
  const triCount = Math.floor(soup.length / 9)
  if (triCount === 0) return []
  // Vertex ids by exact float32 position (soups come from a shared mesh, so shared
  // corners are bit-identical).
  const vertexIds = new Map<string, number>()
  const parent: number[] = []
  const find = (id: number): number => {
    let root = id
    while (parent[root] !== root) root = parent[root]!
    while (parent[id] !== root) { const next = parent[id]!; parent[id] = root; id = next }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const vertexId = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`
    let id = vertexIds.get(key)
    if (id === undefined) {
      id = vertexIds.size
      vertexIds.set(key, id)
      parent[id] = id
    }
    return id
  }
  const triVertex = new Int32Array(triCount)
  for (let t = 0; t < triCount; t += 1) {
    const o = t * 9
    const a = vertexId(soup[o]!, soup[o + 1]!, soup[o + 2]!)
    const b = vertexId(soup[o + 3]!, soup[o + 4]!, soup[o + 5]!)
    const c = vertexId(soup[o + 6]!, soup[o + 7]!, soup[o + 8]!)
    union(a, b)
    union(a, c)
    triVertex[t] = a
  }
  const byRoot = new Map<number, number[]>()
  for (let t = 0; t < triCount; t += 1) {
    const root = find(triVertex[t]!)
    const list = byRoot.get(root)
    if (list) list.push(t)
    else byRoot.set(root, [t])
  }
  return [...byRoot.values()]
    .sort((a, b) => b.length - a.length)
    .map((triangles) => {
      const part = new Float32Array(triangles.length * 9)
      triangles.forEach((t, index) => part.set(soup.subarray(t * 9, t * 9 + 9), index * 9))
      return part
    })
}

/**
 * Cut connector bores INTO a half, so the hole is real geometry rather than a negative volume the
 * slicer resolves later.
 *
 * NO BOOLEAN. Our evaluator cannot do this job: a cylindrical bore meets a flat face along a curve,
 * which is exactly where it leaves cracks, and every drilled box it produced came back open at every
 * resolution from 16 to 96 sides. It does not need one either, because the two things being combined
 * are both ours and both simple. The bore's mouth lies exactly ON the cut plane, and the half's cut
 * face is a flat cap we generated -- so the hole is just that cap re-triangulated with the bore's
 * footprint as an interior loop, plus the bore's own walls turned inside out to face the void.
 *
 * The pieces this leans on already exist: `triangulateCrossSection` groups loops by containment
 * depth and treats an enclosed one as a hole, and clipping a bore to the half it belongs in is an
 * ordinary plane cut. That matters for a DOWEL, whose bore straddles the plane -- clipping gives it
 * a mouth on the plane exactly as a plug already has.
 *
 * Returns the half unchanged when there is nothing to drill or the cap cannot be rebuilt, so a
 * failure here costs the hole and never the part.
 *
 * PER BORE, which is the whole point of reporting `drilled` as a list. A bore can be skipped on its
 * own -- it clipped to nothing on this side, or its mouth left no closed outline -- while its
 * neighbours drill normally, and the caller has to know WHICH: it drops the negative volume of every
 * hole that became real geometry, so one boolean for the whole half dropped the volume describing a
 * hole nobody cut, leaving that connector's peg with nothing to mate with and nothing logged.
 */
export function drillBoresIntoHalf(
  half: Float32Array,
  bores: readonly Float32Array[],
  axis: CutAxis,
  value: number,
  side: 'upper' | 'lower'
): DrilledHalf {
  if (bores.length === 0 || half.length === 0) return { soup: half, drilled: bores.map(() => false) }
  if (axis === 'z') return drillBoresAtZ(half, bores, value, side)
  const forward = axis === 'x' ? 1 : 2
  const back = axis === 'x' ? 2 : 1
  const drilled = drillBoresAtZ(
    cycleAxes(half, forward),
    bores.map((bore) => cycleAxes(bore, forward)),
    value,
    side
  )
  // Rotated back only when something changed: `cycleAxes` copies, and an undrilled half must come
  // back IDENTICAL so `triangleSoupsEqual`-style identity checks upstream still hold.
  return drilled.drilled.some(Boolean)
    ? { soup: cycleAxes(drilled.soup, back), drilled: drilled.drilled }
    : { soup: half, drilled: drilled.drilled }
}

/** A drilled half, plus which of the bores it was given actually became a hole. */
export interface DrilledHalf {
  soup: Float32Array
  /** One entry per bore, in the order they were passed. */
  drilled: boolean[]
}

function drillBoresAtZ(
  half: Float32Array,
  bores: readonly Float32Array[],
  planeZ: number,
  side: 'upper' | 'lower'
): DrilledHalf {
  const nothingDrilled = (): DrilledHalf => ({ soup: half, drilled: bores.map(() => false) })
  // Measured over the half AND the bores, because the bores are clipped by `cutTriangleSoupAtZ`
  // below and everything that survives at the plane has to read as on-plane here too.
  const tolerance = writtenPlaneToleranceAt(coordinateMagnitude(planeZ, [half, ...bores]))
  const atPlane = (soup: Float32Array, o: number): boolean =>
    Math.abs(soup[o + 2]! - planeZ) <= tolerance
    && Math.abs(soup[o + 5]! - planeZ) <= tolerance
    && Math.abs(soup[o + 8]! - planeZ) <= tolerance

  // The half's own cut face, and everything else.
  const body: number[] = []
  const capSegments: number[] = []
  let capFacing = 0
  const capEdges = new Map<string, { count: number; x1: number; y1: number; x2: number; y2: number }>()
  for (let o = 0; o + 8 < half.length; o += 9) {
    if (!atPlane(half, o)) {
      for (let i = 0; i < 9; i++) body.push(half[o + i]!)
      continue
    }
    // Which way the cap faces has to be preserved: the lower half's is its top (+Z), the upper
    // half's its underside (-Z), and a rebuilt cap facing the wrong way is an inside-out hole.
    capFacing += (half[o + 3]! - half[o]!) * (half[o + 7]! - half[o + 1]!)
      - (half[o + 4]! - half[o + 1]!) * (half[o + 6]! - half[o]!)
    accumulateBoundaryEdge(capEdges, half, o)
  }
  if (capEdges.size === 0) return nothingDrilled()
  for (const edge of capEdges.values()) {
    if (edge.count !== 1) continue
    capSegments.push(edge.x1, edge.y1, edge.x2, edge.y2)
  }

  // Each bore, clipped to the side it belongs in so its mouth sits on the plane. A plug's already
  // does; a dowel's straddles and would otherwise contribute geometry outside this half.
  const drilled = bores.map(() => false)
  const wallTriangles: number[] = []
  const holeSegments: number[] = []
  bores.forEach((bore, index) => {
    const halves = cutTriangleSoupAtZ(bore, planeZ)
    const clipped = side === 'upper' ? halves.upper : halves.lower
    if (clipped.length === 0) return
    const mouthEdges = new Map<string, { count: number; x1: number; y1: number; x2: number; y2: number }>()
    const walls: number[] = []
    for (let o = 0; o + 8 < clipped.length; o += 9) {
      if (atPlane(clipped, o)) {
        // The mouth is where the hole opens; it becomes a loop in the cap rather than a surface.
        accumulateBoundaryEdge(mouthEdges, clipped, o)
        continue
      }
      // Reversed: these faces now bound the VOID, so they must look into it. Any vertex sitting on
      // the plane is SNAPPED onto it exactly, because the rebuilt cap writes its mouth at exactly
      // `planeZ` while the clip leaves these a few ULP off -- one point geometrically, two under the
      // bit-exact identity the closedness test uses, and the seam between bore and face then comes
      // apart along every edge of the mouth.
      walls.push(
        clipped[o]!, clipped[o + 1]!, snapToPlane(clipped[o + 2]!, planeZ, tolerance),
        clipped[o + 6]!, clipped[o + 7]!, snapToPlane(clipped[o + 8]!, planeZ, tolerance),
        clipped[o + 3]!, clipped[o + 4]!, snapToPlane(clipped[o + 5]!, planeZ, tolerance)
      )
    }
    const mouth: number[] = []
    for (const edge of mouthEdges.values()) {
      if (edge.count !== 1) continue
      mouth.push(edge.x1, edge.y1, edge.x2, edge.y2)
    }
    // A bore that opened no outline on the cap cannot become a hole, and its walls must not be kept
    // either: inward-facing geometry with no mouth to reach it is a sealed inverted shell floating
    // inside solid material. Skipping the bore WHOLE is what leaves its negative volume as the
    // honest description of the hole.
    if (mouth.length === 0) return
    drilled[index] = true
    for (const value of walls) wallTriangles.push(value)
    for (const value of mouth) holeSegments.push(value)
  })
  if (holeSegments.length === 0) return nothingDrilled()

  const rebuilt = triangulateCrossSection([...capSegments, ...holeSegments])
  if (rebuilt.length === 0) return nothingDrilled()
  const out = body
  for (const [a, b, c] of rebuilt) {
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    // Wound to match the cap this replaces.
    const ccw = (area2 >= 0) === (capFacing >= 0) ? [a, b, c] : [a, c, b]
    out.push(
      ccw[0]!.x, ccw[0]!.y, planeZ,
      ccw[1]!.x, ccw[1]!.y, planeZ,
      ccw[2]!.x, ccw[2]!.y, planeZ
    )
  }
  for (const value of wallTriangles) out.push(value)
  // Re-triangulating the face can drop a COLLINEAR vertex the walls still carry: a square wall built
  // from two triangles crosses the plane as two chords meeting at a midpoint, and a rebuilt cap that
  // spans that midpoint in one edge leaves a T-junction the walls cannot pair with. That is exactly
  // what the heal is for, and it is cheap here because it only touches deficient edges.
  return { soup: healTriangleSoupTJunctions(new Float32Array(out)), drilled }
}

/** Pull a coordinate onto the plane when it is already there to within rounding. */
function snapToPlane(z: number, planeZ: number, tolerance: number): number {
  return Math.abs(z - planeZ) <= tolerance ? planeZ : z
}

/** Tally a triangle's three edges, so the ones used once can be read off as its boundary. */
function accumulateBoundaryEdge(
  edges: Map<string, { count: number; x1: number; y1: number; x2: number; y2: number }>,
  soup: Float32Array,
  o: number
): void {
  const q = (v: number) => Math.round(v / CHAIN_QUANTUM)
  for (let i = 0; i < 3; i++) {
    const a = o + i * 3
    const b = o + ((i + 1) % 3) * 3
    const ka = `${q(soup[a]!)},${q(soup[a + 1]!)}`
    const kb = `${q(soup[b]!)},${q(soup[b + 1]!)}`
    if (ka === kb) continue
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
    const seen = edges.get(key)
    if (seen) seen.count += 1
    else edges.set(key, { count: 1, x1: soup[a]!, y1: soup[a + 1]!, x2: soup[b]!, y2: soup[b + 1]! })
  }
}

/**
 * One side of the cut, undrilled, ready for {@link capSoupForHalf}.
 *
 * The two are split rather than one call because the caller HOLDS this across connector edits. It is
 * the expensive half -- a full cut of the whole object -- and it depends only on the plane, while
 * the connector preview is rebuilt on every connector placed and every drag of a size slider.
 * Recomputing it there re-cut a dense model on each React commit and made the sliders unusable.
 */
export function cutHalfForSide(
  soup: Float32Array,
  axis: CutAxis,
  value: number,
  side: 'upper' | 'lower'
): Float32Array {
  const halves = cutTriangleSoup(soup, axis, value)
  return side === 'upper' ? halves.upper : halves.lower
}

/**
 * Just the CAP of an already-cut half: drill the bores into it, then keep the triangles lying in the
 * plane, as a world-space soup.
 *
 * This is what makes connector placement possible rather than blind. The cut plane preview is a
 * translucent quad passing THROUGH a solid model, so the section itself is hidden inside the
 * geometry and a user aiming at it is guessing -- which is exactly what BambuStudio avoids by
 * clipping the object at the plane and showing the real cut face (`ObjectClipper`). Rendering this
 * cap, with the near half clipped away, shows the same thing, and raycasting against it makes a
 * click EXACT: anything that hits the cap is inside the cross-section by construction.
 *
 * Derived from the cut rather than re-derived alongside it: the half is cut and the triangles lying
 * in the plane are the cap. That is a little wasteful and deliberately so -- a second implementation
 * of the outline would be a second thing to keep in step with the capping rules, which are subtle
 * enough already (coplanar faces, valley edges, per-half outlines).
 *
 * `bores` are the holes to take out first, supplied by the connector tool so the preview is the face
 * the cut will ACTUALLY produce rather than an undrilled one with pegs floating on top of it.
 */
export function capSoupForHalf(
  half: Float32Array,
  axis: CutAxis,
  value: number,
  side: 'upper' | 'lower',
  bores?: readonly Float32Array[]
): Float32Array {
  const lower = bores?.length ? drillBoresIntoHalf(half, bores, axis, value, side).soup : half
  const component = axis === 'x' ? 0 : axis === 'y' ? 1 : 2
  // Generous next to PLANE_EPSILON: these vertices were WRITTEN at the plane, so the only spread is
  // float32 rounding at the model's own magnitude.
  const tolerance = writtenPlaneToleranceAt(coordinateMagnitude(value, [lower]))
  const out: number[] = []
  for (let o = 0; o + 8 < lower.length; o += 9) {
    if (Math.abs(lower[o + component]! - value) > tolerance) continue
    if (Math.abs(lower[o + 3 + component]! - value) > tolerance) continue
    if (Math.abs(lower[o + 6 + component]! - value) > tolerance) continue
    for (let i = 0; i < 9; i++) out.push(lower[o + i]!)
  }
  return new Float32Array(out)
}

/**
 * A tongue-and-groove ("dovetail") cut: BambuStudio's `CutMode::cutTongueAndGroove`.
 *
 * The upper half keeps a TONGUE and the lower half gains the matching GROOVE, so the two pieces
 * interlock instead of merely butting together. Angles are RADIANS here, as they are in Studio's
 * `Groove` struct; the panel converts, because its sliders are in degrees.
 */
export interface GrooveCut {
  /** Groove depth in mm: it spans `+/- depth/2` about the cut plane. */
  depth: number
  /** Groove width in mm, measured at the TOP of the groove. */
  width: number
  /**
   * Flank tilt, radians. Below a right angle the groove is wider at the bottom than the top, which
   * is the undercut that makes it a dovetail; at exactly a right angle it is a plain rectangular
   * groove, and above one it inverts into a V and stops holding anything.
   */
  flapsAngle: number
  /** Taper along the groove's length, radians, so the tongue slides in from one end. Usually 0. */
  grooveAngle: number
  /** Clearance in mm taken off the tongue's depth so the joint is not interference-fit. */
  depthTolerance: number
  /** Clearance in mm taken off the tongue's width, half from each flank. */
  widthTolerance: number
}

/** Studio's own defaults (`GLGizmoAdvancedCut.cpp`), less `depth`/`width`, which scale with the model. */
export const GROOVE_CUT_DEFAULTS = {
  flapsAngle: Math.PI / 3,
  grooveAngle: 0,
  depthTolerance: 0.1,
  widthTolerance: 0.1
} as const

/** Studio's UI bounds, in the units its sliders use. */
export const GROOVE_CUT_LIMITS = {
  flapsAngleDegrees: { min: 30, max: 120 },
  grooveAngleDegrees: { min: 0, max: 15 },
  tolerance: { min: 0, max: 2 }
} as const

/**
 * A groove sized for the model it is being cut into, as Studio sizes its own
 * (`GLGizmoAdvancedCut.cpp:2336`): half the "grabber mean size", which is the bounding box's mean
 * dimension over 30, floored at 1mm, with the width four times the depth.
 *
 * Sized from the model rather than fixed because a groove is a JOINT: 4mm deep is a sturdy key in a
 * 100mm box and an amputation on a 6mm one.
 */
export function grooveDefaultsForSize(size: { x: number; y: number; z: number }): { depth: number; width: number } {
  const depth = Math.max(1, 0.5 * ((size.x + size.y + size.z) / 30))
  return { depth, width: 4 * depth }
}

/**
 * The range the depth and width controls allow, which Studio also derives from the model
 * (`render_slider_double_input`): 1mm at the low end, and the bounding box's summed dimensions
 * halved at the high end. Deliberately generous rather than exact, since a groove that overruns the
 * geometry simply cuts through it.
 */
export function grooveSizeLimitsForSize(size: { x: number; y: number; z: number }): { min: number; max: number } {
  return { min: 1, max: Math.max(1, (size.x + size.y + size.z) / 2) }
}

/**
 * Whether a groove's flanks describe a shape that can actually be cut, porting the arithmetic half
 * of Studio's `has_valid_groove` (`GLGizmoAdvancedCut.cpp:2159`), which gates its own Perform
 * button.
 *
 * Past a right angle the flanks lean the other way and the groove narrows towards its mouth, so
 * beyond a certain tilt the two flanks cross before they reach the top and there is no groove left.
 * Studio compares the width the flanks consume against the groove's own width; below a right angle
 * that quantity is negative and every groove passes, which is why this only ever bites on the
 * inverted side.
 */
export function isGrooveShapeValid(groove: GrooveCut): boolean {
  const flapsWidth = (-2 * groove.depth) / Math.tan(groove.flapsAngle)
  return flapsWidth <= groove.width
}

/**
 * Cut a soup into an interlocking pair with the plane `axis = value`.
 *
 * Ported from `Cut::perform_with_groove` (`CutUtils.cpp:789-979`), which is NOT a special mesh
 * operation: it runs SEVEN ordinary planar cuts over a scratch copy and harvests one side of each.
 * Four of the seven are tilted, which is the whole reason {@link cutTriangleSoupByPlane} exists.
 *
 * The sequence, and which side each step keeps, is Studio's:
 *
 * 1. above `+depth/2`   -> upper          4. outboard of the right flank -> lower
 * 2. below `-depth/2`   -> lower          5-7. shave the tongue by the tolerances
 * 3. outboard of the left flank -> lower  then whatever remains is the tongue -> upper
 *
 * Two things worth knowing. Studio's final cut passes `KeepUpper` where the symmetry says
 * `KeepLower`, but it then reads the tongue out of the scratch object instead, so the argument is
 * dead and either value gives the same output; ours simply does not have that argument. And the
 * tolerances shave the TONGUE, never the groove, so a joint is loose by exactly what was asked for
 * rather than by twice it.
 */
export function grooveCutPieces(
  soup: Float32Array,
  axis: CutAxis,
  value: number,
  groove: GrooveCut
): { upperParts: Float32Array[]; lowerParts: Float32Array[] } {
  const halfDepth = 0.5 * groove.depth
  // Studio's `h_side_shift`: half the groove's width at its WIDEST, which is the bottom for an
  // undercut flank. `tan` is why a right-angle flap gives a plain rectangular groove: the term
  // vanishes and both flanks stand straight up.
  const sideShift = 0.5 * (groove.width + groove.depth / Math.tan(groove.flapsAngle))

  // The cut plane's own frame: +Z along the chosen axis, so the groove's depth runs along the cut
  // normal and its width across the local X, exactly as Studio lays it out against `m_rotate_matrix`.
  // The groove's own frame: +Z along the cut normal, its WIDTH across the local X. Which world
  // direction that lands on is whatever `setFromUnitVectors` picks, and it is not consistent between
  // axes: for a Z or Y cut the width runs along world X, for an X cut it runs along world -Z. So a
  // left/right split slides its tongue vertically up the print while a front/back split slides it
  // horizontally. Studio takes the same frame from `m_rotate_matrix`, which its user can turn; ours
  // exposes no groove rotation, so the convention is fixed. Stated here so a later reader does not
  // read the X case as a bug -- it is a missing control, not a wrong transform.
  const frame = new THREE.Quaternion().setFromUnitVectors(UNIT_Z, axisUnitVector(axis))
  // Centred on the MODEL, not on the world origin. Studio positions its groove at the cut plane's
  // own centre (`m_plane_center`); using `axis * value` instead put the groove wherever the model
  // happened to sit relative to (0,0), which on a model standing away from the origin ran the flanks
  // through its edge and grazed its own faces.
  const origin = soupBoundsCenter(soup)
  origin.setComponent(axis === 'x' ? 0 : axis === 'y' ? 1 : 2, value)
  const along = (local: THREE.Vector3) => local.clone().applyQuaternion(frame).add(origin)
  const tilted = (pitch: number, yaw: number) =>
    UNIT_Z.clone().applyQuaternion(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, pitch, yaw, 'XYZ'))
    ).applyQuaternion(frame)

  const cutNormal = axisUnitVector(axis)
  const leftNormal = tilted(-groove.flapsAngle, -groove.grooveAngle)
  const rightNormal = tilted(groove.flapsAngle, groove.grooveAngle)

  const upperParts: Float32Array[] = []
  const lowerParts: Float32Array[] = []

  // 1: everything above the groove's ceiling is untouched upper half.
  const ceiling = cutTriangleSoupByPlane(soup, { origin: along(new THREE.Vector3(0, 0, halfDepth)), normal: cutNormal })
  upperParts.push(ceiling.upper)

  // 2: everything below its floor is untouched lower half.
  const floor = cutTriangleSoupByPlane(ceiling.lower, { origin: along(new THREE.Vector3(0, 0, -halfDepth)), normal: cutNormal })
  lowerParts.push(floor.lower)

  // 3 and 4: what the flanks cut off the slab between them belongs to the LOWER half, because that
  // is the material the groove is carved out of.
  const left = cutTriangleSoupByPlane(floor.upper, { origin: along(new THREE.Vector3(-sideShift, 0, 0)), normal: leftNormal })
  lowerParts.push(left.upper)
  const right = cutTriangleSoupByPlane(left.lower, { origin: along(new THREE.Vector3(sideShift, 0, 0)), normal: rightNormal })
  lowerParts.push(right.upper)

  // What the flanks leave behind in that slab is the tongue.
  let tongue = right.lower

  // 5 to 7: shave the tongue so the joint has clearance. Taken off the tongue alone, never the
  // groove, so a joint is loose by exactly what was asked for rather than by twice it.
  //
  // SKIPPED at zero, and not merely as an optimisation. Each of these planes is offset from one the
  // tongue was just cut by, so at zero tolerance they coincide EXACTLY with faces the tongue already
  // has, and the cut is then asked to slice a solid along its own face three times over. The two
  // tilted ones do not survive that reliably, because an oblique cut rotates the soup and the face
  // lands a rounding either side of the plane, so the tongue came back with open edges.
  if (groove.depthTolerance > PLANE_EPSILON) {
    tongue = cutTriangleSoupByPlane(tongue, {
      origin: along(new THREE.Vector3(0, 0, -(halfDepth - groove.depthTolerance))),
      normal: cutNormal
    }).upper
  }
  if (groove.widthTolerance > PLANE_EPSILON) {
    tongue = cutTriangleSoupByPlane(tongue, {
      origin: along(new THREE.Vector3(-(sideShift - 0.5 * groove.widthTolerance), 0, 0)),
      normal: leftNormal
    }).lower
    tongue = cutTriangleSoupByPlane(tongue, {
      origin: along(new THREE.Vector3(sideShift - 0.5 * groove.widthTolerance, 0, 0)),
      normal: rightNormal
    }).lower
  }

  upperParts.push(tongue)
  return {
    upperParts: upperParts.filter((part) => part.length > 0),
    lowerParts: lowerParts.filter((part) => part.length > 0)
  }
}

/**
 * Cut a soup into an interlocking pair, one soup per half.
 *
 * The seven cuts leave each half as SEVERAL pieces meeting along the groove's faces, and they are
 * CONCATENATED rather than unioned, which is what BambuStudio does too
 * (`merge_solid_parts_inside_object` joins them with `TriangleMesh::merge`, a plain triangle
 * append). Following suit is not deference here: it is measurably the better of the two.
 *
 * A CSG union was tried first, on the theory that a concatenated half could not serve as an operand
 * in our own mesh boolean, which gates on `isClosedSoup`. It buys nothing and costs plenty. These
 * pieces meet on EXACTLY coplanar faces, which is the case the evaluator handles worst: measured on
 * a 20mm cube with a 4mm-deep, 8mm-wide groove, concatenation gives closed halves of 140 and 96
 * triangles where the union gives OPEN ones of 295 and 140.
 *
 * **KNOWN DEFECT: a grooved half can come back with a boundary, and it DOES reach the defaults.**
 * Measured over model sizes 10-200mm, each at the origin and at a plate centre, using the tool's own
 * `grooveDefaultsForSize` values: 7 of 42 (size x placement x axis) produce a half `isClosedSoup`
 * rejects. Across a realistic band around those defaults it is ~9%. An earlier note here claimed the
 * defaults were safe; that came from testing ONE 40mm cube at the origin, and testing larger and
 * plate-placed models is what showed otherwise.
 *
 * What the failures have in common is narrow: nearly all are the UPPER half (the tongue) on the Y
 * axis, and placement matters independently of size -- a 10mm cube at the origin is fine while the
 * same cube at a plate centre is not. Three plausible causes were investigated and are NOT it:
 * groove-to-model ratio (failures rise with model size, not with the ratio), corner positions
 * disagreeing between the chainer and the bit-exact closedness test (fixed here, small improvement),
 * and an absolute plane tolerance competing with float32's relative precision (fixed here, no
 * measurable improvement on this defect).
 *
 * Until the cause is found, `EditorView` REFUSES a dovetail whose halves fail the check rather than
 * handing over geometry that slices oddly and is later refused as a boolean operand with no hint of
 * where it came from. That guard is the reason this is not user-visible corruption; it is still a
 * cut the user cannot make.
 *
 * Note that this is no longer the old argument that the evaluator cannot produce a closed mesh at
 * all. It can, since `meshTJunctions.ts` heals its output, and two overlapping cubes now union to
 * something `isClosedSoup` accepts. Coplanar abutment is a harder case than overlap, and it is
 * specifically the one a groove produces.
 *
 * The predicate holds here because it was built for this shape: its own tests pin that an
 * over-shared edge is not an open mesh, and that a coincident flap on a closed solid is covered
 * surface rather than a hole.
 */
export function cutTriangleSoupWithGroove(
  soup: Float32Array,
  axis: CutAxis,
  value: number,
  groove: GrooveCut
): CutHalves {
  const { upperParts, lowerParts } = grooveCutPieces(soup, axis, value, groove)
  return { upper: concatSoups(upperParts), lower: concatSoups(lowerParts) }
}

/** Centre of a soup's bounding box. */
function soupBoundsCenter(soup: Float32Array): THREE.Vector3 {
  if (soup.length === 0) return new THREE.Vector3()
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i + 2 < soup.length; i += 3) {
    minX = Math.min(minX, soup[i]!); maxX = Math.max(maxX, soup[i]!)
    minY = Math.min(minY, soup[i + 1]!); maxY = Math.max(maxY, soup[i + 1]!)
    minZ = Math.min(minZ, soup[i + 2]!); maxZ = Math.max(maxZ, soup[i + 2]!)
  }
  return new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
}

/** The world unit vector a cut axis points along. */
function axisUnitVector(axis: CutAxis): THREE.Vector3 {
  if (axis === 'x') return new THREE.Vector3(1, 0, 0)
  if (axis === 'y') return new THREE.Vector3(0, 1, 0)
  return new THREE.Vector3(0, 0, 1)
}

/** Join triangle soups end to end, skipping empties. */
function concatSoups(soups: ReadonlyArray<Float32Array>): Float32Array {
  let total = 0
  for (const soup of soups) total += soup.length
  const out = new Float32Array(total)
  let offset = 0
  for (const soup of soups) { out.set(soup, offset); offset += soup.length }
  return out
}
