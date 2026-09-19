/**
 * The selection outline is the only thing still drawn on a selected object while a tool mode owns
 * the viewport, so it has to stay quiet. Two properties keep it that way, and both were wrong at
 * once before: it is DEPTH-TESTED (so the model hides its own back edges, instead of a twelve-edge
 * cage floating around it), and it is PADDED (so depth-testing does not immediately z-fight against
 * the flat faces that a bounding box coincides with on most real parts).
 *
 * They are tested together on purpose: turning on the depth test without the pad trades one visual
 * defect for a worse one, so a change that keeps only half of this is a regression.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  EXTRA_SELECTION_STYLE,
  PRIMARY_SELECTION_STYLE,
  SELECTION_OUTLINE_LAYER,
  SELECTION_OWNER_LAYER,
  createSelectionBox,
  createSelectionOwnerTracker,
  fitSelectionBox,
  renderSelectionOverlay,
  selectionBoxNeedsPreciseBounds,
  setSelectionOwner
} from './selectionBox'

test('rotation and scale keep exact bounds throughout the gesture', () => {
  assert.equal(selectionBoxNeedsPreciseBounds({
    interacting: true,
    changedOrientation: true,
    dragJustEnded: false,
    upgrade: false
  }), true)
  assert.equal(selectionBoxNeedsPreciseBounds({
    interacting: true,
    changedOrientation: false,
    dragJustEnded: false,
    upgrade: false
  }), false, 'a pure move paid for a per-vertex walk')
})

test('outlines are depth-tested, so edges behind the model are hidden', () => {
  const helper = createSelectionBox(new THREE.Box3(), PRIMARY_SELECTION_STYLE)
  const material = helper.material as THREE.LineBasicMaterial
  assert.equal(material.depthTest, true,
    'outline draws through the model: all twelve edges show and it reads as a cage, not a highlight')
})

test('outlines are translucent, and co-selected boxes are dimmer than the primary', () => {
  const primary = createSelectionBox(new THREE.Box3(), PRIMARY_SELECTION_STYLE)
  const extra = createSelectionBox(new THREE.Box3(), EXTRA_SELECTION_STYLE)
  const primaryMaterial = primary.material as THREE.LineBasicMaterial
  const extraMaterial = extra.material as THREE.LineBasicMaterial
  assert.ok(primaryMaterial.opacity < 1, 'primary outline is fully opaque')
  assert.ok(extraMaterial.opacity < primaryMaterial.opacity,
    'a co-selected box is as loud as the one being acted on')
})

test('the fitted box clears the geometry it wraps, so a flat face cannot z-fight it', () => {
  const source = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 10))
  const fitted = fitSelectionBox(new THREE.Box3(), source)
  assert.ok(fitted.min.x < source.min.x, 'outline sits on the surface, not outside it')
  assert.ok(fitted.max.z > source.max.z, 'outline sits on the surface, not outside it')
  // A pad big enough to read as a gap would make the box lie about the object's size.
  assert.ok(fitted.max.z - source.max.z < 0.5, 'pad is large enough to misreport the object bounds')
})

test('the floor is raised, not lowered, so the bed cannot swallow the bottom edges', () => {
  // An object rests at z = 0. Padding the floor DOWNWARD like the other five faces buries the
  // bottom rectangle under the bed, which occludes it once outlines are depth-tested: the box
  // silently loses its entire lower edge. That shipped, and is what this pins.
  const resting = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 10))
  const fitted = fitSelectionBox(new THREE.Box3(), resting)
  assert.ok(fitted.min.z > 0, `bottom edge sits at or below the bed (z=${fitted.min.z})`)
  assert.ok(fitted.min.z < 0.5, 'bottom edge floats far enough to read as detached from the bed')
})

test('an empty box stays empty rather than being inflated into a visible speck', () => {
  // A selection whose group has no printable geometry (all helper volumes) yields an empty box;
  // padding that would put a small outline at the world origin, attached to nothing.
  const fitted = fitSelectionBox(new THREE.Box3(), new THREE.Box3())
  assert.equal(fitted.isEmpty(), true)
})

test('an outline is not on the main pass layer, so only the overlay draws it', () => {
  // Depth-testing an outline against the WHOLE scene is what let an unrelated model standing in
  // front chop the selection cue into fragments. Keeping it off layer 0 is what stops the main
  // pass drawing it at all; put it back and the outline is depth-tested against everything again.
  const helper = createSelectionBox(new THREE.Box3(), PRIMARY_SELECTION_STYLE)
  assert.equal(helper.layers.mask, 1 << SELECTION_OUTLINE_LAYER)
  assert.equal(helper.layers.test(new THREE.Layers()), false, 'a default camera would draw the outline')
})

test('only MESHES are marked as owners, and unmarking puts them back', () => {
  // The depth pre-pass overrides every material, so a line or a sprite caught by this would write
  // depth of its own and punch a hole in the outline it was supposed to leave alone.
  const owner = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  const decoration = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())
  owner.add(mesh, decoration)

  setSelectionOwner(owner, true)
  assert.equal(mesh.layers.test(ownerOnly()), true)
  assert.equal(decoration.layers.test(ownerOnly()), false, 'a decoration writes depth over the outline')
  assert.equal(mesh.layers.test(new THREE.Layers()), true, 'owner mesh dropped out of the main pass')

  setSelectionOwner(owner, false)
  assert.equal(mesh.layers.test(ownerOnly()), false)
})

/** A camera mask that sees the owner layer alone, i.e. what the depth pre-pass renders with. */
function ownerOnly(): THREE.Layers {
  const layers = new THREE.Layers()
  layers.set(SELECTION_OWNER_LAYER)
  return layers
}

test('the owner tracker clears the objects it drops, and no-ops on an unchanged set', () => {
  const tracker = createSelectionOwnerTracker()
  const first = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  const second = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())

  assert.equal(tracker.active, false, 'overlay would run with nothing selected')
  tracker.sync(new Set([first]))
  assert.equal(tracker.active, true)
  assert.equal(first.layers.test(ownerOnly()), true)

  // Selection moves to the other object: the old owner must stop writing depth, or it keeps hiding
  // an outline that now belongs to something else entirely.
  tracker.sync(new Set([second]))
  assert.equal(first.layers.test(ownerOnly()), false, 'a deselected object still occludes outlines')
  assert.equal(second.layers.test(ownerOnly()), true)

  tracker.dispose()
  assert.equal(second.layers.test(ownerOnly()), false)
  assert.equal(tracker.active, false)
})

test('the overlay detaches the background while it draws, and restores everything after', () => {
  // THE bug this pass shipped with. `autoClear = false` is not enough: three force-clears the
  // colour buffer on every `render()` of a scene whose `background` is a COLOUR, so each overlay
  // pass repainted the background over the main pass and the viewport went empty but for the
  // outlines. Asserted by watching what the scene looks like DURING each render, not just after.
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0d1322)
  const camera = new THREE.PerspectiveCamera()
  const seen: Array<{ background: unknown; autoClear: boolean; mask: number }> = []
  const renderer = {
    autoClear: true,
    clearDepth() {},
    render() {
      seen.push({ background: scene.background, autoClear: renderer.autoClear, mask: camera.layers.mask })
    }
  } as unknown as THREE.WebGLRenderer

  renderSelectionOverlay(renderer, scene, camera)

  assert.equal(seen.length, 2, 'expected a depth pre-pass and an outline pass')
  for (const pass of seen) {
    assert.equal(pass.background, null, 'background repaints over the main pass image')
    assert.equal(pass.autoClear, false, 'pass clears the colour buffer')
  }
  assert.equal(seen[0]!.mask, 1 << SELECTION_OWNER_LAYER, 'depth pre-pass drew more than the owner')
  assert.equal(seen[1]!.mask, 1 << SELECTION_OUTLINE_LAYER, 'outline pass drew more than the outlines')

  // Borrowed state goes back, or the NEXT frame's main pass renders with the overlay's settings.
  assert.ok(scene.background instanceof THREE.Color, 'background not restored: viewport loses its backdrop')
  assert.equal(renderer.autoClear, true)
  assert.equal(camera.layers.mask, new THREE.Layers().mask)
  assert.equal(scene.overrideMaterial, null)
})

test('a throw mid-overlay still hands back everything it borrowed', () => {
  // Every value the overlay changes belongs to the MAIN pass, so losing one does not break the
  // overlay -- it breaks the next ordinary frame. A lost context or a failed shader compile inside
  // either render would have left the scene backgroundless and `autoClear` off permanently, which
  // reads as the viewport turning black for good over a frame that had nothing to do with selection.
  const scene = new THREE.Scene()
  const background = new THREE.Color(0x0d1322)
  scene.background = background
  const camera = new THREE.PerspectiveCamera()
  const renderer = {
    autoClear: true,
    clearDepth() {},
    render() { throw new Error('context lost') }
  } as unknown as THREE.WebGLRenderer

  assert.throws(() => renderSelectionOverlay(renderer, scene, camera), /context lost/)

  assert.equal(scene.background, background, 'the viewport lost its backdrop for good')
  assert.equal(renderer.autoClear, true, 'the next frame would never clear')
  assert.equal(camera.layers.mask, new THREE.Layers().mask, 'the next frame would render one layer')
  assert.equal(scene.overrideMaterial, null, 'the next frame would draw depth-only, i.e. nothing')
})
