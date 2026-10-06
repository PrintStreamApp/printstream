/**
 * Owns the editor measurement overlay and its scene-object lifetime. A picked feature gets a
 * screen-sized marker; a two-point result may add a dimension, axis legs, extension lines, and
 * an angle arc. The live picker reads centre targets only after this hook mounts the group.
 */
import { useEffect, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { disposeObject3D } from './lib/threeMfScene'
import { canSetXyzDistance, type DistAndPoints, type MeasurementResult } from './lib/measureBetween'
import { isCircleCentrePick } from './lib/measureFeatures'
import type { MeasurePick } from './lib/editorMeasurePicking'
import {
  createMeasureFeatureHighlight,
  createMeasureLabelSprite,
  MEASURE_ARROWHEAD_PX,
  MEASURE_CENTRE_MARKER_NAME,
  MEASURE_HOVER_COLOR,
  MEASURE_POINT_COLORS,
  SCREEN_SPACE_OVERLAY_KEY,
  SCREEN_SPACE_PX_KEY,
  type GizmoMode
} from './editorGeometry'

interface MeasurementOverlayOptions {
  sceneRef: MutableRefObject<THREE.Scene | null>
  gizmoMode: GizmoMode
  measurePoints: ReadonlyArray<MeasurePick>
  measureResult: MeasurementResult | null
  measureCentreTargetsRef: MutableRefObject<Array<{ object: THREE.Object3D; slot: number }>>
  sceneReady: boolean
  rebuildToken: number
}

type CentreTarget = { object: THREE.Object3D; slot: number }

/** Flatten picked highlights so the screen-space updater can reach every marker. */
function addPickedHighlights(group: THREE.Group, measurePoints: ReadonlyArray<MeasurePick>): CentreTarget[] {
  const centreTargets: Array<{ object: THREE.Object3D; slot: number }> = []
  measurePoints.forEach((pick, index) => {
    // Each selection takes a colour of its own, distinct from the hover's -- see
    // MEASURE_POINT_COLORS for why a click used to change nothing visible at all.
    const color = MEASURE_POINT_COLORS[index] ?? MEASURE_POINT_COLORS[0]
    // The SOURCE is drawn, not the measured feature: picking a hole's centre in point mode gives a
    // bare point, and drawing only that loses the ring that says which hole it came from.
    // FLATTENED into the overlay group rather than nested: the screen-space sync walks the scene's
    // top-level children plus ONE level inside a flagged group, so a highlight kept as a group of
    // its own hides its markers two levels down where nothing scales them. They then draw at their
    // world size -- 1mm across, which happens to look about right at one zoom and grows with the
    // model at every other.
    //
    // Which of a circle's two parts was picked decides which one is drawn LOUD. A centre selected
    // out of a hole is the source circle's own centre marker promoted, not a second highlight over
    // it: drawing the point separately would stack a marker on the dot already there and leave the
    // ring at full strength, so the two selections would look alike.
    const centreOfSource = isCircleCentrePick(pick.feature, pick.source)
    const sourceHighlight = createMeasureFeatureHighlight(
      pick.source,
      color,
      centreOfSource ? 'centre' : 'rim'
    )
    const centre = sourceHighlight.getObjectByName(MEASURE_CENTRE_MARKER_NAME)
    group.add(...sourceHighlight.children)
    if (pick.source !== pick.feature && !centreOfSource) {
      group.add(...createMeasureFeatureHighlight(pick.feature, color).children)
    }
    // Collected HERE rather than by position afterwards: a pick with a derived point contributes a
    // second highlight, and the dimension line, legs and arc are appended after every pick, so no
    // index into the finished group maps back to a slot.
    if (centre && pick.source.kind === 'circle') centreTargets.push({ object: centre, slot: index })
  })
  return centreTargets
}

/** Suppress a dimension when its anchors coincide or its length is below one micron. */
function visibleDistanceAnchors(measureResult: MeasurementResult | null): DistAndPoints | null {
  // The dimension itself spans whatever the measurement anchored to, which is not simply the two
  // features' own positions: a point-to-edge distance lands on the edge's nearest point, and an
  // oblique edge-to-plane one lands on a boundary edge of the face.
  const measured = measureResult?.distanceInfinite ?? measureResult?.distanceStrict
  // A ZERO-LENGTH dimension is not drawn. Two edges meeting at a corner are genuinely 0.00mm
  // apart, and a dimension line of no length with a "0.00 mm" tag floating on the corner is
  // clutter over a fact the panel already states. Studio's own guard, and both of its conditions:
  // coincident anchors, or a distance under a micron (`GLGizmoMeasure.cpp:1508`).
  const anchors = measured
    && measured.from.distanceToSquared(measured.to) >= 1e-6
    && Math.abs(measured.dist) >= 0.001
    ? measured
    : null
  return anchors
}

/** Draw a dimension line with inward-pointing heads and its distance label. */
function addDistanceDimension(group: THREE.Group, anchors: DistAndPoints | null): void {
  if (anchors) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([anchors.from, anchors.to]),
      new THREE.LineBasicMaterial({ color: MEASURE_HOVER_COLOR, transparent: true, opacity: 0.9, depthTest: false })
    )
    line.renderOrder = 7
    line.frustumCulled = false
    group.add(line)
    // ARROWHEADS at each end, which is what makes this read as a dimension rather than as a line
    // that happens to join two things. Sized in SCREEN pixels like the markers, so they stay
    // legible at any zoom; a cone scales uniformly, so one value does it.
    const along = anchors.to.clone().sub(anchors.from).normalize()
    // Each head's TIP sits on its anchor with the body lying back along the dimension, which is
    // what a dimension arrow is. The cone's apex is at its origin and its body runs along -Y, and
    // `setFromUnitVectors` maps +Y onto `facing`, so the body ends up along -facing: the arrow at
    // `from` therefore takes -along, not +along. Given the two the other way round both heads
    // stick out PAST the ends, away from the line they belong to.
    for (const [at, facing] of [
      [anchors.from, along.clone().negate()],
      [anchors.to, along]
    ] as const) {
      const head = new THREE.Mesh(
        // Height 1 with the tip at +Y after the shift below, so the screen-space scale IS its
        // length rather than a factor on a cone that already has one.
        new THREE.ConeGeometry(0.3, 1, 12),
        new THREE.MeshBasicMaterial({ color: MEASURE_HOVER_COLOR, depthTest: false })
      )
      head.geometry.translate(0, -0.5, 0)
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), facing)
      head.position.copy(at)
      head.userData[SCREEN_SPACE_PX_KEY] = MEASURE_ARROWHEAD_PX
      head.renderOrder = 7
      group.add(head)
    }
    const label = createMeasureLabelSprite(`${anchors.dist.toFixed(2)} mm`)
    if (label) {
      const midpoint = anchors.from.clone().add(anchors.to).multiplyScalar(0.5)
      label.position.set(midpoint.x, midpoint.y, midpoint.z + 4)
      group.add(label)
    }
  }
}

/** Connect a dimension anchored past a bounded edge back to that edge. */
function addExtensionLines(
  group: THREE.Group,
  measurePoints: ReadonlyArray<MeasurePick>,
  anchors: DistAndPoints | null
): void {
  // EXTENSION LINES, where an anchor sits off the feature it belongs to. Measuring a point against
  // an edge it does not overhang anchors on the edge's infinite LINE, so the dimension ends in
  // mid air beside the model with nothing joining it to the edge it describes. Studio draws the
  // same light-grey run (`GLGizmoMeasure.cpp:1717`).
  for (const pick of measurePoints) {
    if (pick.source.kind !== 'edge' || !anchors) continue
    const { start, end } = pick.source
    for (const anchor of [anchors.from, anchors.to]) {
      const along = end.clone().sub(start)
      const t = anchor.clone().sub(start).dot(along) / along.lengthSq()
      // Only an anchor genuinely PAST an end needs one; between them it is already on the edge.
      if (t >= 0 && t <= 1) continue
      const nearest = t < 0 ? start : end
      if (nearest.distanceToSquared(anchor) < 1e-6) continue
      const extension = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([nearest, anchor]),
        new THREE.LineBasicMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.6, depthTest: false })
      )
      extension.renderOrder = 6
      extension.frustumCulled = false
      group.add(extension)
    }
  }
}

/** Show the per-axis distance only when the panel can also explain those components. */
function addAxisLegs(
  group: THREE.Group,
  measurePoints: ReadonlyArray<MeasurePick>,
  anchors: DistAndPoints | null
): void {
  // The per-axis breakdown, drawn as Studio draws it (`GLGizmoMeasure.cpp:2014`): three
  // axis-aligned legs stepping from one anchor to the other in X, then Y, then Z, in the axis
  // colours. It is what turns "48.2mm apart" into "40 across and 27 up", which is the number a
  // user actually needs when deciding whether a part fits.
  // Gated on the SAME predicate the readout uses (`canSetXyzDistance`, via `measurementRows`), or
  // the two disagree: an edge measured against a plane drew red/green/blue legs on the model while
  // the panel showed no X/Y/Z rows, i.e. a per-axis decomposition with no numbers behind it. The
  // panel side of this was fixed on its own once; this is the viewport half.
  const xyzMeaningful = measurePoints.length === 2
    && measurePoints[0] != null && measurePoints[1] != null
    && canSetXyzDistance(measurePoints[0].feature, measurePoints[1].feature)
  if (anchors && xyzMeaningful) {
    const stepX = anchors.from.clone().setX(anchors.to.x)
    const stepY = stepX.clone().setY(anchors.to.y)
    const legs: Array<[THREE.Vector3, THREE.Vector3, number]> = [
      [anchors.from, stepX, 0xff5252],
      [stepX, stepY, 0x5cd65c],
      [stepY, anchors.to, 0x5c8cff]
    ]
    for (const [start, end, color] of legs) {
      // A zero-length leg is two coincident points: drawn, it is an invisible degenerate line that
      // still costs a draw call and a geometry.
      if (start.distanceToSquared(end) < 1e-6) continue
      const leg = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([start, end]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false })
      )
      leg.renderOrder = 6
      leg.frustumCulled = false
      group.add(leg)
    }
  }
}

/** Draw the sampled angle arc and label at the corner being measured. */
function addAngleArc(group: THREE.Group, measureResult: MeasurementResult | null): void {
  // The ANGLE's arc, swept from the first edge to the second about where they meet. Without it an
  // angle is a number in a panel with nothing on the model saying which corner it belongs to --
  // and on a part with several chamfers that is not a small ambiguity.
  const angle = measureResult?.angle
  if (angle && angle.angle > 1e-6) {
    const first = angle.e1[1].clone().sub(angle.e1[0]).normalize()
    const second = angle.e2[1].clone().sub(angle.e2[0]).normalize()
    const axis = new THREE.Vector3().crossVectors(first, second)
    if (axis.lengthSq() > 1e-12) {
      axis.normalize()
      // Studio's own sampling: one segment per ~3 degrees, never fewer than two.
      const steps = Math.max(2, Math.round((64 * angle.angle) / Math.PI))
      const points: THREE.Vector3[] = []
      for (let i = 0; i <= steps; i++) {
        const swept = first.clone().applyAxisAngle(axis, (i / steps) * angle.angle)
        points.push(angle.center.clone().addScaledVector(swept, angle.radius))
      }
      const arc = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: MEASURE_HOVER_COLOR, transparent: true, opacity: 0.9, depthTest: false })
      )
      arc.renderOrder = 7
      arc.frustumCulled = false
      group.add(arc)
      const label = createMeasureLabelSprite(`${((angle.angle * 180) / Math.PI).toFixed(1)}°`)
      if (label) {
        const midpoint = points[Math.floor(points.length / 2)]!
        label.position.copy(midpoint)
        group.add(label)
      }
    }
  }
}

/** Attach and release a measurement overlay for the current picks and scene build. */
export function useEditorMeasurementOverlay(options: MeasurementOverlayOptions): void {
  const {
    sceneRef,
    gizmoMode,
    measurePoints,
    measureResult,
    measureCentreTargetsRef,
    sceneReady,
    rebuildToken
  } = options

  // The overlay lives on the scene root, outside plate thumbnails, and is rebuilt for each pick.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || gizmoMode !== 'measure' || measurePoints.length === 0) return undefined
    const group = new THREE.Group()
    // Flag the group itself: the screen-space pass walks its immediate children only.
    group.userData[SCREEN_SPACE_OVERLAY_KEY] = true

    const centreTargets = addPickedHighlights(group, measurePoints)
    const anchors = visibleDistanceAnchors(measureResult)
    addDistanceDimension(group, anchors)
    addExtensionLines(group, measurePoints, anchors)
    addAxisLegs(group, measurePoints, anchors)
    addAngleArc(group, measureResult)

    scene.add(group)
    // The picker needs world matrices, so publish the centre targets only after mounting.
    measureCentreTargetsRef.current = centreTargets
    return () => {
      measureCentreTargetsRef.current = []
      scene.remove(group)
      disposeObject3D(group)
    }
  }, [measurePoints, measureResult, gizmoMode, sceneReady, rebuildToken,
    measureCentreTargetsRef, sceneRef])
}
