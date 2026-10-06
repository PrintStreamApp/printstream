/**
 * Adapts one object's height band to the shared process-settings catalog.
 * Layer height and material stay in the range editor as the authoritative inputs.
 */
import type { MutableRefObject } from 'react'
import { PER_OBJECT_PROCESS_KEYS } from '@printstream/shared'
import type { ProcessSettingsDialogProps } from '../../components/ProcessSettingsDialog'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { LazyProcessSettingsDialog } from './LazyProcessSettingsDialog'
import { applyEditorHeightRangeSettings } from './lib/editorHeightRangeSettings'
import { effectiveHeightRanges, type EditorHeightRange, type EditorState } from './lib/editorModel'

// Bambu's band reader requires layer_height, which the range editor owns inline. Flush-into
// changes an entire object's wipe behavior and is not a per-band setting. Keep this the same
// curated process subset as the object gear beyond those exclusions.
const HEIGHT_RANGE_TUNABLE_KEYS = PER_OBJECT_PROCESS_KEYS.filter(
  (key) => key !== 'layer_height' && !key.startsWith('flush_into_')
)

interface EditorHeightRangeProcessSettingsDialogProps {
  target: { key: string; objectId: number; name: string }
  rangeIndex: number
  perObject: NonNullable<SliceSettingsController['perObjectSettings']>
  stateRef: MutableRefObject<EditorState | null>
  defaultLayerHeightMm: number
  setObjectHeightRanges: (objectId: number, ranges: EditorHeightRange[]) => void
  resolveConfig: ProcessSettingsDialogProps['resolveConfig']
  onClose: () => void
}

/** Render a range's process settings when its source object and band still exist. */
export function EditorHeightRangeProcessSettingsDialog(props: EditorHeightRangeProcessSettingsDialogProps) {
  const {
    target, rangeIndex, perObject, stateRef, defaultLayerHeightMm,
    setObjectHeightRanges, resolveConfig, onClose
  } = props
  const instance = stateRef.current?.plates.flatMap((plate) => plate.instances)
    .find((entry) => entry.key === target.key)
  if (!instance) return null
  const ranges = effectiveHeightRanges(stateRef.current, instance)
  const band = ranges[rangeIndex]
  if (!band) return null
  const objectOverrides = perObject.value[String(target.objectId)] ?? {}
  const { layer_height: _inline, extruder: _material, ...tunable } = band.settings

  return (
    <LazyProcessSettingsDialog
      open
      applyScope="project"
      onClose={onClose}
      slicerTargetId={perObject.slicerTargetId}
      processProfileId={perObject.processProfileId}
      processProfileName={`${instance.name} · ${band.minZ.toFixed(1)}-${band.maxZ.toFixed(1)} mm`}
      sourceFileId={perObject.sourceFileId}
      initialOverrides={tunable}
      visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}
      allowedKeys={HEIGHT_RANGE_TUNABLE_KEYS}
      baseOverlay={{ ...perObject.globalOverrides, ...objectOverrides }}
      resolveConfig={resolveConfig}
      titlePrefix="Range settings"
      onApply={(overrides) => {
        setObjectHeightRanges(target.objectId, applyEditorHeightRangeSettings(
          ranges, rangeIndex, overrides, defaultLayerHeightMm
        ))
        onClose()
      }}
    />
  )
}
