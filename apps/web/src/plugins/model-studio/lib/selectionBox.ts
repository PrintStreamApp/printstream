/**
 * The editor's selection outlines: the box around the selected object, the dimmer boxes around
 * co-selected instances, and the boxes around selected parts.
 *
 * Extracted because the same material block was written out three times in `useEditorScene` and had
 * to change in all three. Everything about how a selection outline LOOKS belongs here; the scene
 * owns only when to show one and what bounds to fit it to.
 *
 * **Outlines are depth-tested, so the model hides its own back edges.** Drawn without a depth test
 * (which is where these started) all twelve edges show through the object, including the three at
 * the back, which reads as a wireframe cage floating around the model rather than as a highlight on
 * it. That is loud enough to compete with anything else drawn in the viewport, and it was competing
 * with the layer-height shading.
 *
 * The cost of depth-testing is z-fighting exactly where an outline coincides with a flat face, which
 * is the common case (a box-shaped object's bounds ARE its faces). {@link fitSelectionBox} pays for
 * that with a sub-millimetre pad, so the outline sits just outside the surface instead of inside it.
 */
import * as THREE from 'three'

/** The selected object, and any selected part of it. */
export const SELECTION_BOX_COLOR = 0x35e07f
/** Co-selected instances in a multi-selection: present, but not the thing being acted on. */
export const SELECTION_BOX_EXTRA_COLOR = 0x2c9e63

/**
 * How far outside the real bounds an outline sits, mm.
 *
 * Small enough to read as "on the object" at any zoom, large enough to win the depth test against a
 * coincident face. Sub-millimetre because this is a visual-only nudge and the box is also what the
 * user reads dimensions off by eye.
 */
const SELECTION_BOX_PAD_MM = 0.15

interface SelectionBoxStyle {
  color: number
  /** Lower for the co-selected boxes, which must stay present without competing. */
  opacity: number
}

export const PRIMARY_SELECTION_STYLE: SelectionBoxStyle = { color: SELECTION_BOX_COLOR, opacity: 0.65 }
export const EXTRA_SELECTION_STYLE: SelectionBoxStyle = { color: SELECTION_BOX_EXTRA_COLOR, opacity: 0.45 }

/**
 * A selection outline for `box`. The helper keeps a REFERENCE to the box, refitting itself during
 * render, so callers update the outline by writing into that same box via {@link fitSelectionBox}.
 */
export function createSelectionBox(box: THREE.Box3, style: SelectionBoxStyle): THREE.Box3Helper {
  const helper = new THREE.Box3Helper(box, new THREE.Color(style.color))
  const material = helper.material as THREE.LineBasicMaterial
  // Depth-tested on purpose: see the module header. Edges behind the model are meant to be hidden.
  material.depthTest = true
  material.transparent = true
  material.opacity = style.opacity
  helper.renderOrder = 4
  return helper
}

/**
 * Copy `source` into `target` with the pad that keeps the outline clear of a coincident surface.
 *
 * Every write to a selection box's bounds goes through this. Copying a raw `Box3` instead puts the
 * outline exactly on the model's faces, where it z-fights into a dashed, flickering mess on the very
 * objects (anything with a flat side) where a clean box matters most.
 */
export function fitSelectionBox(target: THREE.Box3, source: THREE.Box3): THREE.Box3 {
  target.copy(source)
  if (target.isEmpty()) return target
  target.min.x -= SELECTION_BOX_PAD_MM
  target.min.y -= SELECTION_BOX_PAD_MM
  target.max.x += SELECTION_BOX_PAD_MM
  target.max.y += SELECTION_BOX_PAD_MM
  target.max.z += SELECTION_BOX_PAD_MM
  // The FLOOR is raised, not lowered. An object rests at z = 0, so padding downward like the other
  // five faces puts the bottom rectangle underneath the bed, which then occludes it and the box
  // loses its whole lower edge. Raising it keeps those edges drawn over the bed while the model
  // still hides them wherever it is genuinely in front.
  target.min.z += SELECTION_BOX_PAD_MM
  return target
}
