/**
 * The editor's selection outlines: the box around the selected object, the dimmer boxes around
 * co-selected instances, and the boxes around selected parts.
 *
 * Extracted because the same material block was written out three times in `useEditorScene` and had
 * to change in all three. Everything about how a selection outline LOOKS belongs here; the scene
 * owns only when to show one and what bounds to fit it to.
 *
 * **An outline is hidden by the thing it belongs to, and by nothing else.** Both halves matter.
 * Drawn with no depth test at all (which is where these started) every one of the twelve edges shows
 * through the model, including the three at the back, which reads as a wireframe cage floating
 * around the object rather than as a highlight on it. Depth-tested against the WHOLE scene instead,
 * the opposite failure appears: any unrelated object standing between the camera and the selection
 * eats the outline, so on a full plate the one cue telling you what you are about to move is
 * chopped into fragments by models you did not select.
 *
 * Neither is reachable in a single pass, because one depth buffer cannot hold "the selected object"
 * and "everything else" separately. {@link renderSelectionOverlay} draws the outlines in a pass of
 * their own: clear depth, re-render ONLY the owning geometry into it, then draw the outlines against
 * that. The two layers below are what let each pass address its half without walking the scene.
 *
 * The cost of depth-testing is z-fighting exactly where an outline coincides with a flat face, which
 * is the common case (a box-shaped object's bounds ARE its faces). {@link fitSelectionBox} pays for
 * that with a sub-millimetre pad, so the outline sits just outside the surface instead of inside it.
 */
import * as THREE from 'three'

/**
 * Layer holding ONLY the outlines.
 *
 * A camera renders layer 0 by default, so putting an outline here alone takes it out of the main
 * pass entirely -- {@link renderSelectionOverlay} is then the only thing that draws it, which is
 * what lets it be drawn against a depth buffer of its own.
 */
export const SELECTION_OUTLINE_LAYER = 1
/**
 * Layer holding the MESHES an outline belongs to, in addition to their normal layer 0.
 *
 * Membership is the answer to "what is allowed to hide this outline", so it is exactly the selected
 * object, or the selected part -- never its siblings. Enabled on meshes only: the depth pre-pass
 * overrides every material, and an object's edge-outline and paint-overlay decorations would
 * otherwise write depth of their own and punch holes in the outline.
 */
export const SELECTION_OWNER_LAYER = 2

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
  // `set`, not `enable`: this REPLACES layer 0, so the main pass never draws the outline and cannot
  // depth-test it against the rest of the plate. Its only appearance is the overlay pass.
  helper.layers.set(SELECTION_OUTLINE_LAYER)
  return helper
}

/**
 * Put `object`'s meshes on (or take them off) the owner layer, i.e. declare what may hide its outline.
 *
 * Meshes only, and the whole subtree, so selecting an object covers its parts while selecting one
 * part covers only that part.
 */
export function setSelectionOwner(object: THREE.Object3D, owned: boolean): void {
  object.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return
    if (owned) node.layers.enable(SELECTION_OWNER_LAYER)
    else node.layers.disable(SELECTION_OWNER_LAYER)
  })
}

/**
 * Tracks which objects currently own an outline, applying the layer only when the set CHANGES.
 *
 * The caller re-declares the full set every frame because that is the only cheap way to stay correct
 * across the several routes a selection can change by. Diffing here keeps the per-frame cost
 * proportional to the number of selected objects rather than to their triangle counts -- the
 * subtree walk in {@link setSelectionOwner} then runs on a selection change, not on every orbit frame.
 */
export function createSelectionOwnerTracker() {
  let current = new Set<THREE.Object3D>()
  return {
    /** True when anything is selected, i.e. when the overlay pass has work to do. */
    get active(): boolean {
      return current.size > 0
    },
    sync(next: Set<THREE.Object3D>): void {
      if (next.size === current.size && [...next].every((object) => current.has(object))) return
      for (const object of current) if (!next.has(object)) setSelectionOwner(object, false)
      for (const object of next) if (!current.has(object)) setSelectionOwner(object, true)
      current = next
    },
    dispose(): void {
      for (const object of current) setSelectionOwner(object, false)
      current = new Set()
    }
  }
}

/** Depth-only: fills the depth buffer with the owning geometry while drawing no pixels. */
const OWNER_DEPTH_MATERIAL = new THREE.MeshBasicMaterial({ colorWrite: false })

/**
 * Draw the selection outlines, hidden by their own geometry and by nothing else.
 *
 * Runs AFTER the main render and leaves the renderer, camera and scene exactly as it found them --
 * it borrows `autoClear`, the camera's layer mask and `scene.overrideMaterial` for two passes.
 * Costs two extra scene walks per frame, so callers skip it entirely when nothing is selected.
 */
export function renderSelectionOverlay(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera
): void {
  const previousMask = camera.layers.mask
  const previousAutoClear = renderer.autoClear
  const previousOverride = scene.overrideMaterial
  const previousBackground = scene.background
  // Keep the colour buffer: the main pass's image is what these outlines are drawn on top of.
  renderer.autoClear = false
  // `autoClear = false` is NOT enough on its own. A scene whose `background` is a COLOUR makes three
  // force a colour clear on EVERY `render()` call, autoClear or not (`WebGLBackground.render` sets
  // `forceClear` for that case), so each pass below would repaint the background over the main
  // pass's image and the viewport would show nothing but the outlines. Detaching the background for
  // the overlay is what makes these passes additive; the main pass still paints it.
  scene.background = null
  // `finally`, because every value above is borrowed from the MAIN pass. A throw in either render
  // below (a lost context, a shader that fails to compile) would otherwise leave the scene with no
  // background and the renderer with `autoClear` off for good: the viewport loses its backdrop and
  // never gets it back, on a frame that had nothing to do with the selection.
  try {
    // Depth goes, so nothing the main pass drew can occlude an outline...
    renderer.clearDepth()
    // ...and then only the owning geometry writes depth back, which is what still can.
    camera.layers.set(SELECTION_OWNER_LAYER)
    scene.overrideMaterial = OWNER_DEPTH_MATERIAL
    renderer.render(scene, camera)
    scene.overrideMaterial = previousOverride
    camera.layers.set(SELECTION_OUTLINE_LAYER)
    renderer.render(scene, camera)
  } finally {
    camera.layers.mask = previousMask
    renderer.autoClear = previousAutoClear
    scene.background = previousBackground
    scene.overrideMaterial = previousOverride
  }
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
