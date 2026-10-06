/**
 * Binds an object's authored height bands to the height-range editor. Bounds
 * come from printable geometry in object space, not the enclosing plate.
 */
import type { MutableRefObject } from 'react'
import type * as THREE from 'three'
import { printableMeshBox } from './editorGeometry'
import { HeightRangesDialog } from './HeightRangesDialog'
import {
  effectiveHeightRanges,
  effectiveLayerHeightProfile,
  type EditorHeightRange,
  type EditorState
} from './lib/editorModel'

interface EditorHeightRangesDialogProps {
  target: { key: string; objectId: number; name: string }
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  defaultLayerHeightMm: number
  onChange: (objectId: number, ranges: EditorHeightRange[]) => void
  onEditSettings: (index: number | null) => void
  onClose: () => void
}

/** Render only while the target object still belongs to the session. */
export function EditorHeightRangesDialog(props: EditorHeightRangesDialogProps) {
  const {
    target, stateRef, groupByKeyRef, defaultLayerHeightMm,
    onChange, onEditSettings, onClose
  } = props
  const instance = stateRef.current?.plates.flatMap((plate) => plate.instances)
    .find((entry) => entry.key === target.key)
  if (!instance) return null
  const ranges = effectiveHeightRanges(stateRef.current, instance)
  // With no live group the dialog leaves the top bound open rather than guessing from the bed.
  const group = groupByKeyRef.current.get(target.key)
  const box = group ? printableMeshBox(group) : null
  const objectHeightMm = box ? box.max.z - box.min.z : null

  return (
    <HeightRangesDialog
      objectName={instance.name}
      ranges={ranges}
      objectHeightMm={objectHeightMm}
      defaultLayerHeightMm={defaultLayerHeightMm}
      hasLayerHeightProfile={effectiveLayerHeightProfile(stateRef.current, instance).length > 0}
      extraSettingCount={(range) => Object.keys(range.settings)
        .filter((key) => key !== 'layer_height' && key !== 'extruder').length}
      onChange={(next) => onChange(target.objectId, next)}
      onEditSettings={onEditSettings}
      onClose={onClose}
    />
  )
}
