/**
 * Places editor text against the current host geometry in world space.
 *
 * The caller resolves the font and owns the live React state. This module owns the landing,
 * surface projection, and conversion back into the host's local part coordinates.
 */
import * as THREE from 'three'
import type { Font } from 'opentype.js'
import { isAddedPartMesh, isViewportAidMesh, printableMeshBox, rotorOf } from '../editorGeometry'
import { dotVec, nearestSurfaceAt, worldTrianglesOf } from './textSceneGeometry'
import { buildSurfaceTextSoup, buildTextSoup, glyphAdvances } from './textGeometry'
import {
  arcOffsetNearest, loopLength, loopNearest, nearestFrame, reverseLoop, seatGlyphs, sliceSegments,
  suggestUp
} from './textSurfaceProjection'
import type { TextFontFace } from './textFonts'
import type { TextToolValue } from './textToolValue'

/**
 * Find the current world anchor when rebuilding text. A pointer hit wins; otherwise an added
 * part keeps its live mesh position. A saved baked part has no added key, so use its part index
 * before asking buildTextPlacement to infer a new landing, which could move side-wall text up.
 */
export function textAnchorForEdit(
  group: THREE.Object3D,
  pointed: THREE.Vector3 | null,
  addedPartKey: string | null,
  bakedPartIndex: number | null
): THREE.Vector3 | null {
  if (pointed) return pointed.clone()

  let anchor: THREE.Vector3 | null = null
  if (addedPartKey) {
    rotorOf(group).traverse((node) => {
      if (node.userData.addedPartKey === addedPartKey) {
        anchor = node.getWorldPosition(new THREE.Vector3())
      }
    })
  }
  if (!anchor && bakedPartIndex != null) {
    rotorOf(group).traverse((node) => {
      const ref = node.userData.partRef as { partIndex: number } | undefined
      if (ref?.partIndex === bakedPartIndex) {
        anchor = node.getWorldPosition(new THREE.Vector3())
      }
    })
  }
  return anchor
}

/**
 * Build text on a host or re-seat it on the pointed surface during a drag.
 * The returned mesh coordinates are local to the host's rotor; null means no glyphs were built.
 */
export function buildTextPlacement(
  group: THREE.Object3D,
  textTool: TextToolValue,
  face: TextFontFace,
  font: Font,
  anchorWorld?: THREE.Vector3 | null,
  pointedNormal?: THREE.Vector3 | null
) {
  const geometryOptions = {
    text: textTool.text,
    fontSize: textTool.fontSize,
    thickness: textTool.thickness,
    textGap: textTool.textGap,
    rotateAngle: textTool.rotateAngle
  }
  const soup = buildTextSoup(font, geometryOptions)
  if (soup.length === 0) return null
  const rotor = rotorOf(group)
  rotor.updateWorldMatrix(true, false)
  // Land on real geometry. The bounding box's top is only a surface if the model HAS one at its
  // XY centre; an open box or any concave shape has nothing there, and text placed on the box
  // alone floats in mid air. So drop a ray from above the centre and take the first face it hits,
  // falling back to the box only when the ray misses everything (which a closed model cannot do).
  const box = printableMeshBox(group)
  const centre = box.isEmpty()
    ? new THREE.Vector3()
    : new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.max.z)
  const targets: THREE.Mesh[] = []
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || isViewportAidMesh(mesh)) return
    // ADDED parts are not landing surfaces, and the text's OWN mesh is the one that matters: a
    // rebuild would otherwise drop the ray onto the text placed by the previous rebuild and stack
    // the new one on top of it, climbing by a thickness per keystroke until it floated clear of
    // the model. That is what "floating over the middle of a bowl" was.
    if (isAddedPartMesh(mesh)) return
    targets.push(mesh)
  })
  // SAMPLE the footprint rather than betting on one ray. A single ray down the exact centre is
  // what left text floating: measured on a divided storage box it returned NO hit at all, because
  // the centre line passes through a gap between dividers, so the code fell back to the bounding
  // box top -- which on any open or concave model is thin air above the rim.
  //
  // The highest hit wins, so the text lands on the uppermost real surface near the middle rather
  // than dropping into a well beside it.
  const spanX = (box.max.x - box.min.x) / 4
  const spanY = (box.max.y - box.min.y) / 4
  const above = box.max.z + Math.max(box.max.z - box.min.z, 1)
  let landing: THREE.Intersection | undefined
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]
  ]
  if (!anchorWorld) {
    for (const [dx, dy] of offsets) {
      const ray = new THREE.Raycaster(
        new THREE.Vector3(centre.x + dx * spanX, centre.y + dy * spanY, above),
        new THREE.Vector3(0, 0, -1)
      )
      const hit = ray.intersectObjects(targets, false)[0]
      if (hit && (!landing || hit.point.z > landing.point.z)) landing = hit
    }
  }
  // TEXT LIVES ON A SURFACE. Both of these end at a point the model actually has geometry at,
  // because everything downstream -- the normal, the flat-versus-wrap decision, the cut contour --
  // is meaningless for a point floating in space. Measured on this project's hole insert, the
  // earlier "centre XY at the landing's height" gave a point 47mm from ANY surface, because the
  // centre column passes through a slot: the ray that found the height landed somewhere else
  // entirely, and combining one ray's XY with another's Z lands on nothing.
  //
  // Creating uses where the sampling ray actually hit. Dragging snaps to the nearest surface, so
  // pulling the text off the edge of the model keeps it on the model rather than stranding it.
  // The anchor is ALWAYS resolved onto the surface, even when the pointer named the face.
  //
  // A drag adds the grab offset in world space, which is exact on a plane and drifts on anything
  // curved -- the seat walks off the surface a little further with every move. Once it is off, the
  // cut there is degenerate and the whole run collapses onto a single point: text that behaved for
  // the first few moves and then tangled into a knot. Snapping the point back costs one lookup and
  // makes the drift unaccumulatable.
  //
  // The NORMAL still comes from the pointer when there is one: the cursor named the face, and that
  // is more trustworthy than re-deriving it from a snapped point near an edge.
  const snapped = anchorWorld ? nearestSurfaceAt(anchorWorld, targets, box) : null
  const dragged = pointedNormal && anchorWorld
    ? { point: snapped?.point.clone() ?? anchorWorld.clone(), normal: pointedNormal.clone() }
    : snapped
  const worldPoint = anchorWorld
    ? (dragged?.point.clone() ?? anchorWorld.clone())
    : (landing?.point.clone() ?? new THREE.Vector3(centre.x, centre.y, centre.z))
  const nearby = dragged

  // Everything below is decided in WORLD space and converted ONCE, by inverting the host's world
  // matrix. That matrix carries rotation, scale and any reflection, so a flipped or laid-flat host
  // is handled by construction. Patching a rotation onto a position computed some other way was
  // tried and could not work: the pieces were in different frames.
  //
  // Two things this buys. The text stays upright on the PLATE however the model is oriented, which
  // is what Studio does and what the identity rotation could not give. And the depth offset -- the
  // soup is extruded symmetrically about its own centre, so a Cut left on the surface would remove
  // only half its depth -- is applied along world UP rather than the host's local Z, which on a
  // flipped part pointed into the model instead of out of it.
  const depth = textTool.operation === 'negative_part'
    ? -(textTool.thickness / 2)
    : textTool.thickness / 2 - textTool.embeddedDepth
  /** One flat block on the surface: the mode's own answer, and every surface path's fallback. */
  const flatPlacement = () => {
    const desiredWorld = new THREE.Matrix4().makeTranslation(
      worldPoint.x, worldPoint.y, worldPoint.z + depth
    )
    const local = new THREE.Matrix4().copy(rotor.matrixWorld).invert().multiply(desiredWorld)
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    local.decompose(position, quaternion, scale)
    return {
      face,
      soup,
      position,
      rotation: new THREE.Euler().setFromQuaternion(quaternion),
      scale,
      rotor
    }
  }
  // SURFACE modes do not place a flat block at all: the text is built already lying on the
  // surface, so the geometry carries the placement and the part sits at the host's own origin.
  // This is BambuStudio's model -- a position and normal per character along a cut contour --
  // and it is why text in a bore wraps around it instead of hovering above the rim.
  // A surface mode only means something on a surface that CURVES away from the text. On a flat
  // top face the baseline plane cuts the object's whole silhouette at that height, so the run
  // would wrap around the entire perimeter instead of sitting where the user is looking.
  // BambuStudio's surface text likewise reads as flat on a flat face, so the flat path IS the
  // right answer here rather than a fallback.
  const landedNormal = nearby?.normal
    ?? (landing?.face
      ? landing.face.normal.clone().transformDirection(landing.object.matrixWorld).normalize()
      : new THREE.Vector3(0, 0, 1))
  // No flat-face gate: with the cut plane taken from the surface's own up direction, a flat face
  // yields a straight contour by construction, exactly as it does in Studio. The gate that used to
  // sit here was papering over the world-Z plane below it.
  if (textTool.surfaceMode !== 'horizontal') {
    // Built from the raycast TARGETS, not the whole group: `collectWorldTriangles` keeps a Join
    // text mesh (it is printed geometry, not a viewport aid), so slicing the group would cut the
    // previous rebuild's letterforms along with the host and `loopNearest` could pick a letter's
    // own contour -- the text wrapping around itself. `targets` already excludes added parts.
    //
    // Deliberately NOT cached across the editing session. It looks like the obvious candidate --
    // it walks every triangle of the host, on every keystroke -- and a session cache was built and
    // then removed, because the measurement did not support it: mean main-thread blocking per
    // rebuild went 1368ms -> 1297ms, inside the noise. A CPU profile of the same keystrokes says
    // why. The top twenty self-time entries are ALL React and Joy/emotion (`useSlot`,
    // `useThemeProps`, `handleInterpolation`, `jsxDEV`); not one text-geometry function appears.
    // The per-keystroke cost is the editor's tree re-rendering, not this walk. Cache it only with
    // a profile that actually names it.
    const hostSoup = worldTrianglesOf(targets)
    // The baseline plane sits at the anchor's own height. `depth` does NOT belong here: it is a
    // distance INTO the surface, and on a vertical wall shifting the plane by it just slides the
    // ring up and down the wall. It is applied along each glyph's own normal below instead.
    // BambuStudio's frame (`generate_text_tran_in_world`): z is the surface normal, y is
    // `suggest_up` of it, x is y x z -- and the CUT PLANE's normal is y, the text's own up
    // (`GLGizmoText.cpp:3180`). Slicing with a fixed world-Z plane, as this did, is right only by
    // coincidence on a vertical wall: on a flat face a horizontal cut returns that face's
    // OUTLINE, so the text could only fan around a circle. Studio carries no flat-face special
    // case because its plane is vertical there, and a vertical cut of a flat face is a line.
    const seat = { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z }
    const surfaceZ = { x: landedNormal.x, y: landedNormal.y, z: landedNormal.z }
    // `surfaceHorizontal` forces up to WORLD up (Studio's SURFACE_HORIZONAL, `GLGizmoText.cpp:1429`),
    // which makes the cut plane horizontal whatever the surface is doing. That is the whole
    // difference between the two modes: plain `surface` takes its plane from the surface, so on a
    // tilted or domed face the contour rises and falls and the letters ride it -- correct, but it
    // reads as a ragged baseline. Horizontal cuts at constant height, so the baseline is level.
    const baseUp = textTool.surfaceMode === 'surfaceHorizontal' && Math.abs(surfaceZ.z) < 0.999
      ? { x: 0, y: 0, z: 1 }
      : suggestUp(surfaceZ)
    // Angle rotates the FRAME about the surface normal, as Studio's `generate_text_tran_in_world`
    // composes `rotate_trans` into the text transform. Rotating the frame turns the cut plane with
    // it, so the contour, the reading direction and every glyph follow -- rotating the glyphs
    // alone would tilt the letters off a baseline that had not moved.
    const surfaceUp = textTool.rotateAngle === 0
      ? baseUp
      : (() => {
        const rotated = new THREE.Vector3(baseUp.x, baseUp.y, baseUp.z)
          .applyAxisAngle(landedNormal.clone().normalize(), THREE.MathUtils.degToRad(textTool.rotateAngle))
        return { x: rotated.x, y: rotated.y, z: rotated.z }
      })()
    // The contour the POINTED point sits on, not the longest in the cut: a cut through a real part
    // yields several (outer silhouette, recess wall, every bore) and the longest is almost always
    // the silhouette, which is what made the text wrap "something invisible".
    const loop = loopNearest(sliceSegments(hostSoup, seat, surfaceUp), seat)
    // Orient the loop before anything is measured along it. Which way `chainLongestLoop` walked is
    // an accident of its seed triangle, and that direction becomes the text's reading direction --
    // walked the wrong way the glyph basis inverts (`yAxis = zAxis x xAxis`), so the letters come
    // out mirrored AND laid down back to front. Both symptoms, one sign.
    //
    // `landedNormal` is the reference for which way is OUT, because it comes from the raycast's
    // own face normal -- the value three.js RENDERS with -- rather than from a cross product,
    // which is winding dependent and silently inverts on a mesh wound inconsistently.
    const reference = nearestFrame(loop, worldPoint)
    let reading = loop
    if (reference) {
      const facing = dotVec(reference.normal, landedNormal) < 0 ? -1 : 1
      const outward = new THREE.Vector3(reference.normal.x, reference.normal.y, reference.normal.z)
        .multiplyScalar(facing)
      // Upright text reads along up x out. Degenerate on a floor or ceiling, where "upright" means
      // nothing and the loop's own direction is as good an answer as any.
      const desired = new THREE.Vector3(surfaceUp.x, surfaceUp.y, surfaceUp.z).cross(outward)
      if (desired.lengthSq() > 0.01) {
        desired.normalize()
        const tangent = new THREE.Vector3(
          reference.tangent.x, reference.tangent.y, reference.tangent.z
        )
        if (tangent.dot(desired) < 0) reading = reverseLoop(loop)
      }
    }
    const advances = glyphAdvances(font, geometryOptions)
    // Centred on the point the text was placed at, NOT on the loop's start. The loop begins at
    // whichever triangle the chainer seeded from, so seating from zero wrapped the text properly
    // and then put it on the far side of the model from the pointer.
    const runLength = advances.reduce((sum, advance) => sum + advance, 0)
    // Keep the WHOLE run on the contour by sliding it, rather than letting the ends fall off:
    // `seatGlyphs` drops any glyph running past the end of an OPEN contour, which loses letters
    // from text placed near one. A closed contour is exempt -- a bore wraps, so there is no end to
    // slide from, and clamping would drag the text off the point the user placed it at.
    let start = arcOffsetNearest(reading, worldPoint) - runLength / 2
    const first = reading[0]
    const last = reading[reading.length - 1]
    const closed = first != null && last != null
      && Math.hypot(last.b.x - first.a.x, last.b.y - first.a.y, last.b.z - first.a.z) < 1e-3
    const spanLength = loopLength(reading)
    if (!closed && spanLength > runLength) {
      start = Math.min(Math.max(start, 0), spanLength - runLength)
    }
    // A contour SHORTER than the run cannot hold it: a closed one wraps the text over itself and
    // a knot of overlapping letters is what reaches the user. Falling through to flat placement is
    // the honest answer -- text that is visibly not wrapped beats text tangled into a ball.
    if (spanLength < runLength) return flatPlacement()
    const frames = seatGlyphs(reading, advances, start)
    if (frames.some(Boolean)) {
      // Same outward reference as the loop orientation above, for the same reason.
      const facing = reference && dotVec(reference.normal, landedNormal) < 0 ? -1 : 1
      // Stand each glyph off along the surface it sits on. The soup is extruded symmetrically
      // about its own centre, so a glyph left exactly on the contour is half inside the wall --
      // which on a Cut removes only half the depth asked for, and on a Join buries half the
      // letterform. Along the NORMAL, not world up, because that is the only direction that means
      // "out of the surface" for a wall as well as a floor.
      const seated = frames.map((frame) => {
        if (!frame) return null
        const normal = {
          x: frame.normal.x * facing, y: frame.normal.y * facing, z: frame.normal.z * facing
        }
        return {
          ...frame,
          normal,
          position: {
            x: frame.position.x + normal.x * depth,
            y: frame.position.y + normal.y * depth,
            z: frame.position.z + normal.z * depth
          }
        }
      })
      const worldSoup = buildSurfaceTextSoup(font, geometryOptions, seated)
      if (worldSoup.length > 0) {
        // Into the host's frame, since a part's geometry is stored object-local.
        const toLocal = new THREE.Matrix4().copy(rotor.matrixWorld).invert()
        // Wrapped geometry is built in place, so it would naturally sit at the host's origin with
        // the placement baked into the vertices. It is re-centred on the anchor instead, and the
        // anchor handed back as the part's position, so the part's TRANSFORM still says where the
        // text is. Dragging depends on that: the gizmo reports the mesh's world position, and if
        // every wrap sat at the origin, that reading would be the host's origin no matter where
        // the letters actually were, and the next re-projection would snap them back to it.
        const localAnchor = worldPoint.clone().applyMatrix4(toLocal)
        const point = new THREE.Vector3()
        for (let i = 0; i < worldSoup.length; i += 3) {
          point.set(worldSoup[i]!, worldSoup[i + 1]!, worldSoup[i + 2]!).applyMatrix4(toLocal)
          worldSoup[i] = point.x - localAnchor.x
          worldSoup[i + 1] = point.y - localAnchor.y
          worldSoup[i + 2] = point.z - localAnchor.z
        }
        return {
          face,
          soup: worldSoup,
          position: localAnchor,
          rotation: new THREE.Euler(),
          scale: new THREE.Vector3(1, 1, 1),
          rotor
        }
      }
    }
    // No contour at that height (the plane missed, or the text is longer than an open arc):
    // fall through to flat placement rather than silently adding nothing.
  }

  return flatPlacement()

}
