/**
 * Offscreen plate-thumbnail renderer for the interactive 3D editor.
 *
 * Renders a plate's contents (a `THREE.Group` of instance meshes plus its bed
 * bounds) to a small WebGL render target and returns a PNG data URL. The single
 * renderer/scene/camera are reused across plates and thumbnail requests; callers
 * own the lifecycle via `createPlateThumbnailRenderer().dispose()`.
 *
 * The thumbnail uses the same Bambu-style iso framing as the main editor so the
 * snapshot reflects the edited layout. It does NOT take ownership of the passed
 * group's geometry/materials — the caller keeps and disposes those.
 */
import * as THREE from 'three'
import { BAMBU_THREE_MF_ISO_UP, BAMBU_THREE_MF_ISO_VIEW } from './viewCube'

const THUMBNAIL_SIZE = 256

export interface PlateThumbnailRenderer {
  /**
   * Render `group` (already positioned in plate-local frame) framed over its bed
   * and return a PNG data URL. The group is temporarily parented into the
   * offscreen scene and removed again before returning, so it can stay attached
   * to the live editor scene between calls (pass a detached clone if needed).
   */
  render(group: THREE.Object3D, bed: { minX: number; maxX: number; minY: number; maxY: number }): string
  dispose(): void
}

/** Build a reusable offscreen thumbnail renderer. Call `dispose()` on teardown. */
export function createPlateThumbnailRenderer(): PlateThumbnailRenderer {
  // Transparent background + model-only framing, to match BambuStudio's clean plate thumbnails
  // (no bed, no background) rather than a screenshot of the editor scene.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE)
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  scene.background = null
  // BambuStudio-style rig (Slic3r's two fixed directional lights over a
  // moderate ambient): a dominant upper-left key and a weak front fill, so top
  // faces read brightest and vertical walls fall off visibly. The previous
  // hemisphere wash lit every face almost equally, which made our thumbnails
  // flatter and brighter than Bambu's for the same model.
  scene.add(new THREE.AmbientLight(0xffffff, 0.65))
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0)
  keyLight.position.set(-0.4575, 0.4575, 0.7625)
  scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.35)
  fillLight.position.set(0.6985, 0.1397, 0.6985)
  scene.add(fillLight)

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 6000)
  camera.up.set(BAMBU_THREE_MF_ISO_UP.x, BAMBU_THREE_MF_ISO_UP.y, BAMBU_THREE_MF_ISO_UP.z)

  return {
    render(group, bed) {
      scene.add(group)
      // Freshly-built groups (non-active plates) haven't had their world matrices computed yet, so
      // force an update before measuring — otherwise the box sits at the local origin and the model
      // renders off-centre.
      group.updateMatrixWorld(true)

      // Hide non-model scene dressing (bed surface, prime tower) so the thumbnail shows just the
      // printed models — like Bambu's. Restored after the snapshot.
      const hidden: THREE.Object3D[] = []
      group.traverse((child) => {
        if ((child.userData?.isBedSurface || child.userData?.isPrimeTower || child.userData?.isModifier) && child.visible) {
          child.visible = false
          hidden.push(child)
        }
      })

      // Frame on the visible model geometry (not the bed) so the part fills the thumbnail.
      // traverseVisible (not traverse) so meshes inside hidden groups — e.g. the bed
      // surface's plane, which is hidden via its group root above — don't inflate the
      // framing box and shrink the model in the snapshot.
      const box = new THREE.Box3()
      group.traverseVisible((child) => {
        const mesh = child as THREE.Mesh
        if (mesh.isMesh) box.expandByObject(mesh)
      })
      const usingModelBox = !box.isEmpty()
      const target = usingModelBox
        ? box.getCenter(new THREE.Vector3())
        : new THREE.Vector3((bed.minX + bed.maxX) / 2, (bed.minY + bed.maxY) / 2, 0)
      // Use the bounding-sphere radius so the model never clips under the iso projection (a box's
      // diagonal projects wider than any single side).
      const size = usingModelBox ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(bed.maxX - bed.minX, bed.maxY - bed.minY, 0)
      const span = usingModelBox
        ? Math.hypot(size.x, size.y, size.z)
        : Math.max(size.x, size.y)
      const radius = span * 0.58 + 1 // half-diagonal + small padding
      camera.left = -radius
      camera.right = radius
      camera.top = radius
      camera.bottom = -radius
      const distance = Math.max(span, 1) * 4
      camera.position.set(
        target.x + distance * BAMBU_THREE_MF_ISO_VIEW.x,
        target.y + distance * BAMBU_THREE_MF_ISO_VIEW.y,
        target.z + distance * BAMBU_THREE_MF_ISO_VIEW.z
      )
      camera.near = 0.1
      camera.far = distance * 6
      camera.lookAt(target)
      camera.updateProjectionMatrix()

      renderer.render(scene, camera)
      const url = renderer.domElement.toDataURL('image/png')
      for (const object of hidden) object.visible = true
      scene.remove(group)
      return url
    },
    dispose() {
      renderer.dispose()
    }
  }
}
