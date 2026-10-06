/**
 * Synchronizes persistent paint-overlay visibility in one editor viewport.
 *
 * Colour paint represents the printed result and normally stays visible; support and seam paint
 * are annotations for the selected object and active channel. Manipulation and layer-height
 * shading hide every overlay. The viewport calls `sync` only on render frames; unchanged inputs
 * skip the group traversal.
 */
import * as THREE from 'three'
import { PAINT_CHANNEL_SPECS, paintOverlayVisible } from '../editorGeometry'
import type { TrianglePaintChannel } from './threeMfScene'

interface PaintOverlayState {
  activeChannel: TrianglePaintChannel | null
  selectedKey: string | null
  layersEditing: boolean
}

interface PaintOverlayVisibilityOptions {
  getGroups: () => Iterable<[string, THREE.Group]>
  getState: () => PaintOverlayState
}

/** Return a render-frame updater that traverses scene groups only when visibility may change. */
export function createEditorPaintOverlayVisibility({ getGroups, getState }: PaintOverlayVisibilityOptions) {
  const channelByName = new Map<string, TrianglePaintChannel>(
    (Object.entries(PAINT_CHANNEL_SPECS) as Array<[TrianglePaintChannel, { overlayName: string }]>).map(
      ([channel, spec]) => [spec.overlayName, channel]
    )
  )
  let previous: (PaintOverlayState & { interacting: boolean }) | null = null

  const sync = (interacting: boolean) => {
    const { activeChannel, selectedKey, layersEditing } = getState()
    if (previous
      && previous.interacting === interacting
      && previous.activeChannel === activeChannel
      && previous.selectedKey === selectedKey
      && previous.layersEditing === layersEditing) return
    previous = { interacting, activeChannel, selectedKey, layersEditing }

    for (const [key, group] of getGroups()) {
      const isSelected = key === selectedKey
      group.traverse((node) => {
        if (!(node as THREE.Mesh).isMesh || !node.userData.isPaintOverlay) return
        const channel = channelByName.get(node.name)
        node.visible = interacting || layersEditing
          ? false
          : channel != null && paintOverlayVisible(channel, activeChannel, isSelected)
      })
    }
  }

  return { sync }
}
