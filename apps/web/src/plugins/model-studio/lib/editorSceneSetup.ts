/**
 * Builds the editor viewport's camera and lit scene before they are published to live refs.
 *
 * The hook keeps renderer creation, DOM attachment, and teardown. It publishes these objects
 * only after WebGL context creation succeeds, so a refused context leaves no unusable scene refs.
 */
import * as THREE from 'three'
import { ISO_UP } from '../editorGeometry'

/** Create the editor's initial Z-up camera at its generic home direction. */
export function createEditorSceneCamera(
  width: number,
  height: number,
  homeDirection: THREE.Vector3
): THREE.PerspectiveCamera {
  const aspect = Math.max(width, 1) / Math.max(height, 1)
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 5000)
  camera.up.copy(ISO_UP)
  camera.position.set(
    homeDirection.x * 360,
    homeDirection.y * 360,
    homeDirection.z * 360
  )
  return camera
}

/** Create the editor's preview-matched lighting and its empty, replaceable plate root. */
export function createEditorLitScene(): { scene: THREE.Scene; plateRoot: THREE.Group } {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#0d1322')
  scene.add(new THREE.HemisphereLight(0xffffff, 0x5d646b, 1.05))

  const dir = new THREE.DirectionalLight(0xffffff, 0.5)
  dir.position.set(1, 1, 1)
  dir.castShadow = true
  dir.shadow.mapSize.set(2048, 2048)
  dir.shadow.camera.near = 50
  dir.shadow.camera.far = 800
  dir.shadow.camera.left = -260
  dir.shadow.camera.right = 260
  dir.shadow.camera.top = 260
  dir.shadow.camera.bottom = -260
  dir.shadow.bias = -0.0004
  dir.shadow.normalBias = 0.04
  scene.add(dir)

  // Near-neutral underside light avoids tinting glossy angled faces blue.
  const keyLight = new THREE.DirectionalLight(0xfff2d8, 0.36)
  keyLight.position.set(-1.15, 0.8, 1.6)
  scene.add(keyLight)

  const underLight = new THREE.DirectionalLight(0xb9c4cc, 0.12)
  underLight.position.set(-0.35, 0.2, -1)
  scene.add(underLight)

  scene.add(new THREE.AmbientLight(0x9aa4ad, 0.12))
  const plateRoot = new THREE.Group()
  scene.add(plateRoot)
  return { scene, plateRoot }
}
