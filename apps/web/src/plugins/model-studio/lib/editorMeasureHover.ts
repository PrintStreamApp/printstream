/**
 * Owns the measure tool's transient feature highlight in one editor scene.
 * The viewport supplies live picks and disposes this controller before the scene.
 * The highlight's children stay directly under a flagged group so screen-sized
 * point markers are found by the viewport overlay sync.
 */
import * as THREE from 'three'
import {
  isCircleCentrePick,
  sameMeasureFeature,
  type MeasureFeature
} from './measureFeatures'
import {
  createMeasureFeatureHighlight,
  MEASURE_POINT_COLORS,
  MEASURE_POINT_MODE_COLOR,
  SCREEN_SPACE_OVERLAY_KEY
} from '../editorGeometry'
import { disposeObject3D } from './threeMfScene'
import type { MeasurePick } from './editorMeasurePicking'

/** Create a hover controller whose colour follows the current measurement picks. */
export function createEditorMeasureHover(
  scene: THREE.Scene,
  getPicks: () => ReadonlyArray<MeasurePick>
) {
  const group = new THREE.Group()
  group.userData[SCREEN_SPACE_OVERLAY_KEY] = true
  group.renderOrder = 7
  scene.add(group)

  let feature: MeasureFeature | null = null
  let source: MeasureFeature | null = null
  let color: number | null = null
  let emphasis: 'rim' | 'centre' = 'rim'

  const clear = () => {
    for (const child of [...group.children]) {
      group.remove(child)
      disposeObject3D(child)
    }
    feature = null
    source = null
    color = null
  }

  /** Draw the feature a click would select, including its current slot colour. */
  const update = (picked: MeasurePick | null, pointMode = false) => {
    if (!picked) {
      if (feature) clear()
      return
    }

    // Studio's hover_selection_color follows the slot the next click would fill.
    // Re-evaluate it when the next pointer event resolves to the same feature:
    // a click or Shift may have changed the slot or point-mode colour meanwhile.
    const first = getPicks()[0]
    const nextColor = pointMode
      ? MEASURE_POINT_MODE_COLOR
      : MEASURE_POINT_COLORS[!first || sameMeasureFeature(first.feature, picked.feature) ? 0 : 1]!
    const nextEmphasis = isCircleCentrePick(picked.feature, picked.source) ? 'centre' : 'rim'
    if (
      sameMeasureFeature(feature, picked.feature)
      && sameMeasureFeature(source, picked.source)
      && color === nextColor
      && emphasis === nextEmphasis
    ) return

    clear()
    feature = picked.feature
    source = picked.source
    color = nextColor
    emphasis = nextEmphasis

    // Draw the source so a circle keeps its ring while its centre is pointed at.
    const highlight = createMeasureFeatureHighlight(source, color, emphasis)
    group.add(...highlight.children)
  }

  /** Remove the highlight and its scene group before viewport teardown. */
  const dispose = () => {
    clear()
    scene.remove(group)
  }

  return {
    get feature() { return feature },
    get source() { return source },
    clear,
    update,
    dispose
  }
}
