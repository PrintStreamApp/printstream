/**
 * Owns the temporary overlay for a region-based paint tool in one editor viewport.
 *
 * The viewport supplies current tool settings and the region from `useEditorPaint`. An unchanged
 * seed reuses its overlay; a changed seed or teardown removes and disposes the previous one.
 * This controller registers no listeners and owns no source mesh.
 */
import * as THREE from 'three'
import { PAINT_CHANNEL_SPECS, type PaintToolType } from '../editorGeometry'
import { buildTrianglePaintOverlay, type SupportPaintBrushMode } from './supportPaint'
import { disposeObject3D, type TrianglePaintChannel } from './threeMfScene'

interface PaintRegionPreviewOptions {
  getSettings: () => {
    tool: PaintToolType
    mode: SupportPaintBrushMode
    filamentId: number | null
    filamentColors: Record<number, string> | undefined
  }
  previewRegion: (mesh: THREE.Mesh, faceIndex: number) => { codes: Record<number, string> } | null
}

/** Create a preview whose settings and region are read at each pointer update. */
export function createEditorPaintRegionPreview({ getSettings, previewRegion }: PaintRegionPreviewOptions) {
  let current: { host: THREE.Mesh; overlay: THREE.Mesh; key: string } | null = null

  /** Remove the overlay before its host mesh or viewport is disposed. */
  const clear = () => {
    if (!current) return
    current.host.remove(current.overlay)
    disposeObject3D(current.overlay)
    current = null
  }

  /** Draw exactly the region and colour the current paint action would produce. */
  const update = (mesh: THREE.Mesh | null, faceIndex: number | null, channel: TrianglePaintChannel) => {
    if (!mesh || faceIndex == null) {
      clear()
      return
    }

    const { tool, mode, filamentId, filamentColors } = getSettings()
    const key = [mesh.uuid, faceIndex, tool, mode, channel, filamentId ?? ''].join(':')
    if (current?.key === key) return
    clear()

    const region = previewRegion(mesh, faceIndex)
    if (!region) return
    const palette = PAINT_CHANNEL_SPECS[channel].palette
    // The colour the click will produce is more useful than a generic selection colour. Erase
    // previews in a pale tone so it cannot be mistaken for paint that remains on the model.
    const previewHex = mode === 'eraser'
      ? 0xe8edf4
      : channel === 'color'
        ? new THREE.Color(filamentColors?.[filamentId ?? -1] ?? '#9aa4ad').getHex()
        : mode === 'blocker' ? palette.blocker : palette.enforcer
    const overlay = buildTrianglePaintOverlay(mesh.geometry as THREE.BufferGeometry, region.codes, {
      palette,
      name: 'paint-region-preview',
      // Polygon offsets run negative toward the camera. -6 sits above all existing paint layers;
      // a positive value would hide the preview behind the mesh.
      offsetFactor: -6,
      colorForState: () => previewHex
    })
    if (!overlay) return

    const material = overlay.material as THREE.MeshBasicMaterial
    material.transparent = true
    material.opacity = 0.55
    material.depthWrite = false
    overlay.renderOrder = 6
    mesh.add(overlay)
    current = { host: mesh, overlay, key }
  }

  return { get active() { return current != null }, clear, update }
}
