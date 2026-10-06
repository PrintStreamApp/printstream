/**
 * Adapts a live editor plate and project slice configuration to the shared
 * per-plate settings dialog. The plate stays identified by plateId through a
 * reorder, and its filament list contains only physical project materials.
 */
import type { MutableRefObject } from 'react'
import type { ProcessSettingOverrides } from '@printstream/shared'
import type { ProcessConfigResolver } from '../../components/ProcessSettingsDialog'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { PlateSettingsDialog, type PlateSettingsDraft } from './PlateSettingsDialog'
import type { EditorState } from './lib/editorModel'
import { plateDisplayName } from './lib/plateName'

const EMPTY_OBJECT_OVERRIDES: ProcessSettingOverrides = {}

interface EditorPlateSettingsDialogProps {
  plateId: number
  stateRef: MutableRefObject<EditorState | null>
  sliceConfig: SliceSettingsController | undefined
  perObject: SliceSettingsController['perObjectSettings'] | null
  resolveProcessConfig: ProcessConfigResolver | undefined
  onApply: (plateId: number, settings: PlateSettingsDraft) => void
  onClose: () => void
}

/** Render the selected plate's settings when it still belongs to the session. */
export function EditorPlateSettingsDialog(props: EditorPlateSettingsDialogProps) {
  const {
    plateId, stateRef, sliceConfig, perObject, resolveProcessConfig,
    onApply, onClose
  } = props
  const plate = stateRef.current?.plates.find((entry) => entry.plateId === plateId)
  if (!plate) return null

  return (
    <PlateSettingsDialog
      plateLabel={plateDisplayName(plate.name, plate.index)}
      settings={{
        plateTypeOverride: plate.plateTypeOverride,
        printSequence: plate.printSequence,
        firstLayerFilamentSequence: plate.firstLayerFilamentSequence,
        otherLayerFilamentSequences: plate.otherLayerFilamentSequences,
        spiralMode: plate.spiralMode,
        locked: plate.locked
      }}
      // Use the target printer's supported beds so a plate cannot be pinned to an absent surface.
      plateTypeOptions={sliceConfig?.plateTypeOptions ?? []}
      globalPlateType={sliceConfig?.plateType.trim() || null}
      // With no process context the skirt warning stays silent instead of guessing.
      processContext={perObject ? {
        slicerTargetId: perObject.slicerTargetId,
        processProfileId: perObject.processProfileId,
        sourceFileId: perObject.sourceFileId,
        resolveConfig: resolveProcessConfig
      } : null}
      globalProcessOverrides={perObject?.globalOverrides ?? EMPTY_OBJECT_OVERRIDES}
      filaments={(sliceConfig?.projectFilaments ?? [])
        .filter((filament) => !filament.mixedFilament)
        .map((filament) => ({
          id: filament.projectFilamentId,
          label: filament.label,
          color: sliceConfig?.filamentColors[filament.projectFilamentId] ?? filament.color ?? '#FFFFFF'
        }))}
      hasMixedFilaments={(sliceConfig?.projectFilaments ?? []).some((filament) => filament.mixedFilament != null)}
      onApply={(settings) => onApply(plate.plateId, settings)}
      onClose={onClose}
    />
  )
}
