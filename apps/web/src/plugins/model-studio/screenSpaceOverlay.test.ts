/**
 * Annotations that must hold their size on screen however far the camera is.
 *
 * The measure label was sized in MILLIMETRES, which is right at exactly one zoom: a modest tag over
 * a whole plate, and a blurred banner across the viewport once zoomed into the feature being
 * measured, because its texture magnifies with it. Reported from the viewport as "rendered large
 * when zoomed in, and looks bad".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  MEASURE_MARKER_PX,
  SCREEN_SPACE_OVERLAY_KEY,
  SCREEN_SPACE_PX_KEY,
  syncScreenSpaceOverlays
} from './editorGeometry.js'

const VIEWPORT_HEIGHT = 800

function sceneWithMarker(pixels: number, at = new THREE.Vector3()) {
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  group.userData[SCREEN_SPACE_OVERLAY_KEY] = true
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12))
  marker.position.copy(at)
  marker.userData[SCREEN_SPACE_PX_KEY] = pixels
  group.add(marker)
  scene.add(group)
  return { scene, marker }
}

function cameraAt(distance: number) {
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 5000)
  camera.position.set(0, 0, distance)
  camera.updateMatrixWorld(true)
  return camera
}

/** Pixels on screen that `worldSize` world units occupy at `distance`. */
function screenPixels(worldSize: number, distance: number, camera: THREE.PerspectiveCamera) {
  const worldPerPixel = (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / VIEWPORT_HEIGHT
  return worldSize / worldPerPixel
}

/** What a marker actually measures across on screen, geometry included rather than assumed. */
function renderedDiameterPx(marker: THREE.Mesh, distance: number, camera: THREE.PerspectiveCamera) {
  marker.geometry.computeBoundingBox()
  const box = marker.geometry.boundingBox!
  return screenPixels((box.max.y - box.min.y) * marker.scale.y, distance, camera)
}

test('a marker measures its stated DIAMETER on screen, not twice it', () => {
  // The tagged value is the annotation's FULL size, so a sphere has to be built one unit ACROSS.
  // Built at radius 1 -- the obvious thing to write, and what shipped -- every mesh annotation drew
  // at twice its constant while the label sprite beside it was exact, so one key meant "radius" for
  // a mesh and "height" for a sprite. Measured off the geometry, since that is the half that was
  // wrong: asserting on `scale` alone passes either way.
  const distance = 300
  const { scene, marker } = sceneWithMarker(MEASURE_MARKER_PX)
  const camera = cameraAt(distance)
  scene.updateMatrixWorld(true)
  syncScreenSpaceOverlays(scene, camera, VIEWPORT_HEIGHT)
  const measured = renderedDiameterPx(marker, distance, camera)
  assert.ok(
    Math.abs(measured - MEASURE_MARKER_PX) < 1e-6,
    `the marker measured ${measured}px across, not ${MEASURE_MARKER_PX}`
  )
})

test('an annotation holds its pixel size as the camera moves', () => {
  // The whole point: the same marker at 50mm and at 500mm must measure the same on screen.
  for (const distance of [25, 100, 400, 1200]) {
    const { scene, marker } = sceneWithMarker(MEASURE_MARKER_PX)
    const camera = cameraAt(distance)
    scene.updateMatrixWorld(true)
    syncScreenSpaceOverlays(scene, camera, VIEWPORT_HEIGHT)
    assert.ok(
      Math.abs(screenPixels(marker.scale.y, distance, camera) - MEASURE_MARKER_PX) < 1e-6,
      `at ${distance}mm the marker measured ${screenPixels(marker.scale.y, distance, camera)}px`
    )
  }
})

test('a closer camera scales the annotation DOWN, which is what stops it swelling', () => {
  const near = sceneWithMarker(MEASURE_MARKER_PX)
  const far = sceneWithMarker(MEASURE_MARKER_PX)
  near.scene.updateMatrixWorld(true)
  far.scene.updateMatrixWorld(true)
  syncScreenSpaceOverlays(near.scene, cameraAt(50), VIEWPORT_HEIGHT)
  syncScreenSpaceOverlays(far.scene, cameraAt(500), VIEWPORT_HEIGHT)
  assert.ok(near.marker.scale.y < far.marker.scale.y, 'a nearer camera must give a SMALLER world scale')
  // Ten times the distance is ten times the world size, exactly.
  assert.ok(Math.abs(far.marker.scale.y / near.marker.scale.y - 10) < 1e-6)
})

test('distance is measured PER ANNOTATION, not from one point in the scene', () => {
  // Two markers either end of a long measurement are at different depths, and each has to size for
  // its own. Taking the group's distance would leave the far one visibly smaller.
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  group.userData[SCREEN_SPACE_OVERLAY_KEY] = true
  const near = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12))
  near.position.set(0, 0, 0)
  near.userData[SCREEN_SPACE_PX_KEY] = MEASURE_MARKER_PX
  const far = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12))
  far.position.set(0, 0, -300)
  far.userData[SCREEN_SPACE_PX_KEY] = MEASURE_MARKER_PX
  group.add(near, far)
  scene.add(group)
  scene.updateMatrixWorld(true)
  syncScreenSpaceOverlays(scene, cameraAt(400), VIEWPORT_HEIGHT)
  assert.ok(far.scale.y > near.scale.y, 'the further marker needs a larger world scale to match')
})

test('a sprite keeps its aspect, so the label is not squashed', () => {
  const scene = new THREE.Scene()
  const sprite = new THREE.Sprite()
  sprite.userData[SCREEN_SPACE_PX_KEY] = 24
  sprite.userData.screenSpaceAspect = 3.5
  scene.add(sprite)
  scene.updateMatrixWorld(true)
  syncScreenSpaceOverlays(scene, cameraAt(200), VIEWPORT_HEIGHT)
  assert.ok(Math.abs(sprite.scale.x / sprite.scale.y - 3.5) < 1e-9)
})

test('untagged objects are left completely alone', () => {
  // The sync runs every frame over the scene's children, which include the plate and the models.
  const scene = new THREE.Scene()
  const model = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  model.scale.set(2, 3, 4)
  scene.add(model)
  scene.updateMatrixWorld(true)
  syncScreenSpaceOverlays(scene, cameraAt(200), VIEWPORT_HEIGHT)
  assert.deepEqual(model.scale.toArray(), [2, 3, 4])
})

test('a zero-height viewport is a no-op rather than a division by zero', () => {
  // Happens for a frame while a hidden or freshly-mounted canvas has no layout yet; a NaN scale
  // there makes the annotation vanish permanently rather than for that frame.
  const { scene, marker } = sceneWithMarker(MEASURE_MARKER_PX)
  marker.scale.set(1, 1, 1)
  scene.updateMatrixWorld(true)
  syncScreenSpaceOverlays(scene, cameraAt(200), 0)
  assert.deepEqual(marker.scale.toArray(), [1, 1, 1])
})



