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
  createSelectionBox,
  fitSelectionBox
} from './selectionBox'

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
