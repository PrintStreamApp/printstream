/**
 * Adapts the selected editor object and live printable geometry to LayerHeightPanel.
 * Profiles use object-local height and one history checkpoint per brush stroke;
 * the presentational panel owns neither scene lookup nor the edit's history.
 */
import type * as THREE from 'three'
import {
  adaptiveLayerHeightProfile,
  flatLayerHeightProfile,
  paintLayerHeightProfile,
  smoothLayerHeightProfile,
  type LayerHeightBounds
} from '@printstream/shared/three-mf'
import { toast } from '../../lib/toast'
import { printableMeshBox } from './editorGeometry'
import { LayerHeightPanel } from './LayerHeightPanel'
import { effectiveHeightRanges, effectiveLayerHeightProfile, type EditorState } from './lib/editorModel'
import { collectWorldTriangles } from './lib/meshCut'

interface EditorLayerHeightToolPanelProps {
  target: { key: string; objectId: number }
  state: EditorState | null
  groups: ReadonlyMap<string, THREE.Group>
  bounds: LayerHeightBounds
  nominalHeight: number
  firstLayerHeight: number
  onProfileChange: (objectId: number, profile: number[], checkpoint?: boolean) => void
  onBrushChange: (brush: { z: number; bandWidth: number } | null) => void
  onClose: () => void
}

/** Render the layer height controls only while their selected object has printable geometry. */
export function EditorLayerHeightToolPanel(props: EditorLayerHeightToolPanelProps) {
  const {
    target, state, groups, bounds, nominalHeight, firstLayerHeight,
    onProfileChange, onBrushChange, onClose
  } = props
  const instance = state?.plates.flatMap((plate) => plate.instances)
    .find((entry) => entry.key === target.key)
  const group = groups.get(target.key)
  if (!instance || !group) return null

  const box = printableMeshBox(group)
  const objectHeight = box.max.z - box.min.z
  if (!(objectHeight > 0)) return null
  const profile = effectiveLayerHeightProfile(state, instance)

  const commit = (next: number[] | null, checkpoint = true) => {
    if (next) onProfileChange(target.objectId, next, checkpoint)
  }

  /** Adaptive works in the object's height frame, regardless of its plate placement. */
  const objectSoup = () => {
    const soup = collectWorldTriangles(group)
    for (let i = 2; i < soup.length; i += 3) soup[i] = soup[i]! - box.min.z
    return soup
  }

  return (
    <LayerHeightPanel
      objectName={instance.name}
      objectHeight={objectHeight}
      profile={profile}
      bounds={bounds}
      nominalHeight={nominalHeight}
      hasHeightRanges={effectiveHeightRanges(state, instance).length > 0}
      onHover={(z, bandWidth) => onBrushChange(z == null ? null : { z, bandWidth })}
      onPaint={(z, action, bandWidth, firstOfStroke) => commit(paintLayerHeightProfile(
        profile.length > 0 ? profile : flatLayerHeightProfile(objectHeight, nominalHeight, firstLayerHeight),
        z, action,
        { objectHeight, bounds, nominalHeight, bandWidth, strength: 0.02, firstLayerHeight }
      ), firstOfStroke)}
      onAdaptive={(quality) => {
        const next = adaptiveLayerHeightProfile(objectSoup(), {
          objectHeight, bounds, nominalHeight, quality, firstLayerHeight
        })
        if (!next) {
          toast.error('That model has no surface to derive layer heights from.')
          return
        }
        commit(next)
      }}
      onSmooth={(radius, keepMin) => {
        if (profile.length === 0) {
          toast.error('Nothing to smooth yet: run Adaptive or paint first.')
          return
        }
        commit(smoothLayerHeightProfile(profile, objectHeight,
          { bounds, radius, keepMin, firstLayerHeight }))
      }}
      onReset={() => onProfileChange(target.objectId, [])}
      onClose={onClose}
    />
  )
}
