/** Replacement confirmation shared by the workspace and local Model Studio hosts. */
import { memo, useCallback, useState } from 'react'
import { Alert, FormControl, FormLabel, Option, Select } from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { FilamentOptionLabel } from './FilamentOptionLabel'
import { FormDialog } from '../FormDialog'
import type { SliceProjectFilament } from './useMaterialSlots'

export const RemoveMaterialDialog = memo(function RemoveMaterialDialog({ materialId, filaments, colors, onClose, onRemove }: {
  materialId: number | null
  filaments: SliceProjectFilament[]
  colors?: Record<number, string>
  onClose: () => void
  onRemove: (materialId: number, replacementId: number) => void
}) {
  const [selection, setSelection] = useState<{ materialId: number; replacementId: number } | null>(null)
  const close = useCallback(() => {
    setSelection(null)
    onClose()
  }, [onClose])
  const material = filaments.find((entry) => entry.projectFilamentId === materialId)
  const replacementId = selection?.materialId === materialId ? selection?.replacementId : null
  const validSelection = filaments.some((entry) => entry.projectFilamentId === replacementId && replacementId !== materialId)

  const renderMaterial = (entry: SliceProjectFilament, index: number) => (
    <FilamentOptionLabel
      color={colors?.[entry.projectFilamentId] ?? entry.color}
      filamentName={entry.label}
      swatchLabel={String(index + 1)}
      swatchSize={36}
    />
  )

  return (
    <FormDialog
      open={material !== undefined}
      title={`Remove material ${filaments.findIndex((entry) => entry.projectFilamentId === materialId) + 1}`}
      onClose={close}
      submitLabel="Replace and remove"
      submitDisabled={!validSelection}
      onSubmit={() => {
        if (materialId === null || replacementId == null || !validSelection) return
        onRemove(materialId, replacementId)
        close()
      }}
    >
      <Alert color="warning" startDecorator={<WarningAmberRoundedIcon />}>
        Choose a remaining material to replace any objects, paint, or settings that use this material. Existing paint may use it even when no objects are assigned to it.
      </Alert>
      {filaments.some((entry) => entry.mixedFilament?.componentIds.includes(materialId ?? -1)) && (
        <Alert color="warning">Mixed-material recipes using this material will also change. Review their ratios and compatibility before slicing.</Alert>
      )}
      <FormControl>
        <FormLabel>Replacement material</FormLabel>
        <Select
          placeholder="Choose a material"
          value={replacementId ?? null}
          renderValue={(selected) => {
            const index = filaments.findIndex((entry) => entry.projectFilamentId === selected?.value)
            const entry = filaments[index]
            return entry ? renderMaterial(entry, index) : null
          }}
          onChange={(_event, value) => {
            if (materialId !== null && value !== null) setSelection({ materialId, replacementId: value })
          }}
        >
          {filaments.map((entry, index) => entry.projectFilamentId !== materialId && (
            <Option key={entry.projectFilamentId} value={entry.projectFilamentId}>
              {renderMaterial(entry, index)}
            </Option>
          ))}
        </Select>
      </FormControl>
    </FormDialog>
  )
})
