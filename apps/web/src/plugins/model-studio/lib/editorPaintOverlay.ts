/**
 * Builds and attaches a painted-triangle overlay for both scene seeding and brush refreshes.
 * Channel colours, depth offset, and initial visibility must agree across those paths;
 * the caller owns source-code selection and any per-mesh rebuild cache.
 */
import * as THREE from 'three'
import { PAINT_CHANNEL_SPECS, paintOverlayVisible } from '../editorGeometry'
import { remapBaseMaterialPaint } from './materialReplacement'
import type { EditorState } from './editorModel'
import { getGeometryTrianglePaint, type SupportPaintCodes, type TrianglePaintChannel } from './threeMfScene'
import { buildTrianglePaintOverlay, type PaintOverlayCache } from './supportPaint'

/** Resolve a mesh's session override or source paint, including live material remapping. */
export function effectiveEditorPaintCodes(
  mesh: THREE.Mesh,
  paintKey: string,
  channel: TrianglePaintChannel,
  state: EditorState | null
): SupportPaintCodes | null {
  const override = state?.[PAINT_CHANNEL_SPECS[channel].stateKey]?.[paintKey]
  if (override) return Object.keys(override).length > 0 ? override : null

  const base = getGeometryTrianglePaint(mesh.geometry as THREE.BufferGeometry, channel)
  return channel === 'color' ? remapBaseMaterialPaint(state, base) : base
}

/** Attach one channel when it has renderable paint, returning its mesh or null. */
export function attachEditorPaintOverlay(
  mesh: THREE.Mesh,
  channel: TrianglePaintChannel,
  codes: SupportPaintCodes | null,
  options: {
    activeChannel: TrianglePaintChannel | null
    selected: boolean
    colorForState: (state: number) => number | null
    cache?: PaintOverlayCache
  }
): THREE.Mesh | null {
  if (!codes || Object.keys(codes).length === 0) return null

  const spec = PAINT_CHANNEL_SPECS[channel]
  const overlay = buildTrianglePaintOverlay(mesh.geometry as THREE.BufferGeometry, codes, {
    palette: spec.palette,
    name: spec.overlayName,
    offsetFactor: spec.offsetFactor,
    ...(channel === 'color' ? { colorForState: options.colorForState } : {})
  }, options.cache)
  if (!overlay) return null

  // A newly built overlay must start under the same gate the scene reapplies later. Otherwise a
  // rebuild briefly exposes support, seam, or fuzzy paint outside its selected tool.
  overlay.visible = paintOverlayVisible(channel, options.activeChannel, options.selected)
  mesh.add(overlay)
  return overlay
}
