/**
 * Owns one viewport's paint and brim-ear hover visuals.
 *
 * The viewport supplies live tool settings and pointer hits. This controller switches between a
 * surface ring, a volume sphere, and the region preview, then removes every temporary scene object
 * on teardown. It installs no pointer listeners and does not own the source meshes.
 */
import * as THREE from 'three'
import {
  BRIM_EAR_MARKER_COLOR,
  effectivePaintTool,
  PAINT_CHANNEL_SPECS,
  type PaintToolType
} from '../editorGeometry'
import { disposeObject3D, type TrianglePaintChannel } from './threeMfScene'
import type { SupportPaintBrushMode } from './supportPaint'

interface RegionPreview {
  readonly active: boolean
  clear: () => void
  update: (mesh: THREE.Mesh | null, faceIndex: number | null, channel: TrianglePaintChannel) => void
}

interface BrushHoverOptions {
  scene: THREE.Scene
  regionPreview: RegionPreview
  getSettings: () => {
    brimEars: boolean
    channel: TrianglePaintChannel | null
    tool: PaintToolType
    mode: SupportPaintBrushMode
    radius: number
    brimEarDiameter: number
    filamentId: number | null
    filamentColors: Record<number, string> | undefined
  }
}

type BrushHit = {
  point: THREE.Vector3
  normal: THREE.Vector3
  mesh?: THREE.Mesh
  faceIndex?: number | null
}

/** Build hover visuals whose style always follows current editor settings. */
export function createEditorBrushHover({ scene, regionPreview, getSettings }: BrushHoverOptions) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.82, 1, 40),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide })
  )
  ring.visible = false
  ring.renderOrder = 6
  scene.add(ring)

  // The translucent sphere shows the brush's 3D reach; its wireframe stays visible above the
  // surface even when the fill is partly buried in the mesh.
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide })
  )
  const sphereWire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 16, 10)),
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6, depthTest: false, depthWrite: false })
  )
  sphereWire.renderOrder = 7
  sphere.add(sphereWire)
  sphere.visible = false
  sphere.renderOrder = 6
  scene.add(sphere)

  const clear = () => {
    ring.visible = false
    sphere.visible = false
    regionPreview.clear()
  }

  /** Show the cursor or fill region that the current tool would apply at this hit. */
  const update = (hit: BrushHit | null) => {
    if (!hit) {
      clear()
      return
    }

    const { brimEars, channel, tool, mode, radius, brimEarDiameter, filamentId, filamentColors } = getSettings()
    let useSphere = false
    if (!brimEars && channel) {
      const effectiveTool = effectivePaintTool(channel, tool)
      if (effectiveTool !== 'circle' && effectiveTool !== 'sphere') {
        ring.visible = false
        sphere.visible = false
        regionPreview.update(hit.mesh ?? null, hit.faceIndex ?? null, channel)
        return
      }
      useSphere = effectiveTool === 'sphere'
    }
    regionPreview.clear()

    const palette = PAINT_CHANNEL_SPECS[channel ?? 'supports'].palette
    const colorModeHex = channel === 'color'
      ? new THREE.Color(filamentColors?.[filamentId ?? -1] ?? '#9aa4ad').getHex()
      : null
    const color = brimEars
      ? BRIM_EAR_MARKER_COLOR
      : mode === 'eraser'
        ? 0xe8edf4
        : channel === 'color' && colorModeHex != null
          ? colorModeHex
          : mode === 'blocker' ? palette.blocker : palette.enforcer

    if (useSphere) {
      sphere.material.color.setHex(color)
      sphereWire.material.color.setHex(color)
      sphere.position.copy(hit.point)
      sphere.scale.setScalar(radius)
      sphere.visible = true
      ring.visible = false
      return
    }

    ring.material.color.setHex(color)
    if (brimEars) {
      // Ear placement projects to the bed, even when the hit was on a model face.
      ring.position.set(hit.point.x, hit.point.y, 0.1)
      ring.quaternion.identity()
    } else {
      ring.position.copy(hit.point).addScaledVector(hit.normal, 0.05)
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal)
    }
    ring.scale.setScalar(brimEars ? brimEarDiameter / 2 : radius)
    ring.visible = true
    sphere.visible = false
  }

  /** Remove both cursors and the region overlay before viewport teardown. */
  const dispose = () => {
    clear()
    scene.remove(ring, sphere)
    disposeObject3D(ring)
    disposeObject3D(sphere)
  }

  return { get visible() { return ring.visible || sphere.visible || regionPreview.active }, clear, update, dispose }
}
