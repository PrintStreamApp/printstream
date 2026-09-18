/**
 * Material edit dialog: the expanded type/preset/color inputs for ONE material slot,
 * opened from the material's compact swatch row in `SliceSettingsPanel` (directly when no
 * printer is targeted, otherwise through that row's "Choose manually" menu item; the row
 * itself keeps only the swatch + nozzle picker). Edits apply immediately through the
 * slice controller's setters, the same live semantics the inputs had when they sat
 * inline on the row, so "Done" only closes; there is no separate apply/cancel state.
 *
 * In 'add' mode the same inputs choose what a slot WILL be before it exists (`AddMaterialDialog`
 * owns that pending state), which is why the close callback reports the user's intent rather than
 * just closing.
 *
 * This is the MANUAL path only: assigning what the printer already has loaded is the swatch
 * menu's job, so the dialog carries no printer shortcut of its own.
 */
import { useRef } from 'react'
import {
  Box, Button, DialogActions, FormControl, FormHelperText, FormLabel,
  ModalDialog, Option, Select, Stack, Typography
} from '@mui/joy'
import { BackAwareModal } from '../BackAwareModal'
import { FilamentColorPicker } from './FilamentColorPicker'
import { MaterialPresetAutocomplete } from './MaterialPresetAutocomplete'
import type { SliceMaterialOption } from '../../lib/slicingPresetMatching'

export function MaterialEditDialog({
  mode = 'edit',
  filamentIndex,
  filamentLabel,
  typeFilter,
  typeOptions,
  onTypeFilterChange,
  materialOptions,
  selectedOption,
  onMaterialOptionChange,
  color,
  onColorChange,
  onClose
}: {
  /**
   * 'edit' retunes an existing slot; 'add' picks what a NOT-YET-CREATED slot will be, so the
   * caller creates it only on a 'done' close. Adding first and asking after produced slots the
   * user never chose: see `AddedMaterialChoice`.
   */
  mode?: 'edit' | 'add'
  filamentIndex: number
  /** Project filament label (e.g. "PLA"), the color-family fallback when no preset is picked. */
  filamentLabel: string
  typeFilter: string
  typeOptions: string[]
  onTypeFilterChange: (value: string) => void
  /** Material options already narrowed to the current type filter. */
  materialOptions: SliceMaterialOption[]
  selectedOption: SliceMaterialOption | null
  onMaterialOptionChange: (option: SliceMaterialOption | null) => void
  /** Normalized current color hex. */
  color: string
  onColorChange: (color: string) => void
  /** Carries the user's intent: 'add' mode creates the slot only on 'done'. */
  onClose: (outcome: 'done' | 'cancel') => void
}) {
  // Edits apply LIVE through the controller, that is what keeps the editor's dirty flag and undo
  // history correct. So Cancel restores the values the dialog opened with rather than staging edits
  // until Done: same outcome for the user, without diverging from that live-apply contract.
  const opened = useRef({ option: selectedOption, color, typeFilter })
  // Never retain an old pick merely to satisfy Autocomplete's options/value contract.
  // The parent may still carry it while its material state reconciles a type change.
  const compatibleOptions = materialOptions.filter((option) => !typeFilter || option.materialType === typeFilter)
  const compatibleSelection = selectedOption && (!typeFilter || selectedOption.materialType === typeFilter)
    ? selectedOption
    : null
  const revertAndClose = () => {
    const initial = opened.current
    if (initial.typeFilter !== typeFilter) onTypeFilterChange(initial.typeFilter)
    if (initial.option?.id !== selectedOption?.id) onMaterialOptionChange(initial.option)
    if (initial.color !== color) onColorChange(initial.color)
    onClose('cancel')
  }
  return (
    <BackAwareModal open onClose={revertAndClose}>
      <ModalDialog sx={{ maxWidth: 420, width: '100%' }}>
        <Typography level="h4">{mode === 'add' ? 'Add material' : `Material ${filamentIndex + 1}`}</Typography>
        <Stack spacing={1.25}>
          <FormControl>
            <FormLabel>Material type</FormLabel>
            <Select<string>
              value={typeFilter}
              slotProps={{
                listbox: {
                  sx: {
                    maxHeight: { xs: 'min(50vh, 18rem)', sm: 360 },
                    overflowY: 'auto',
                    overscrollBehavior: 'contain'
                  }
                }
              }}
              // Switching type clears the preset: the old pick belongs to the previous
              // material and is no longer in the narrowed list, so leaving it selected
              // shows a preset that contradicts the type above it. Done stays disabled
              // until a preset from the new type is chosen.
              onChange={(_event, value) => {
                const nextType = value ?? ''
                if (nextType === typeFilter) return
                onTypeFilterChange(nextType)
                if (nextType && selectedOption && selectedOption.materialType !== nextType) onMaterialOptionChange(null)
              }}
            >
              <Option value="">All material types</Option>
              {[...typeOptions].sort((left, right) => left.localeCompare(right)).map((option) => (
                <Option key={option} value={option}>{option}</Option>
              ))}
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel>Preset</FormLabel>
            <MaterialPresetAutocomplete
              options={compatibleOptions}
              value={compatibleSelection}
              placeholder="Choose a material profile"
              onChange={onMaterialOptionChange}
            />
            {/* No literal-preset helper line here: the field itself now carries that name, so
                repeating it underneath said the same thing twice. */}
            {/* Only flag the cases needing the user to act, and always say WHY Done is disabled
                rather than leaving a dead button with no explanation. */}
            {!compatibleSelection && (
              <FormHelperText sx={{ color: 'warning.400' }}>
                {compatibleOptions.length > 0
                  ? 'Choose a preset for this material to continue.'
                  : 'No preset is available for this type on the selected printer: pick another type.'}
              </FormHelperText>
            )}
            {selectedOption && selectedOption.source !== 'manual' && !selectedOption.profileId && (
              <FormHelperText sx={{ color: 'warning.400' }}>
                No preset matches this filament: pick one from the list.
              </FormHelperText>
            )}
          </FormControl>
          <FormControl>
            <FormLabel>Color</FormLabel>
            <Box sx={{ display: 'flex', alignItems: 'center', height: 'var(--Input-minHeight, 2.25rem)', width: '100%' }}>
              <FilamentColorPicker
                color={color}
                material={(selectedOption?.material ?? selectedOption?.materialType ?? typeFilter) || filamentLabel}
                materialType={(selectedOption?.materialType ?? typeFilter) || filamentLabel}
                brand={selectedOption?.brand ?? ''}
                fullWidth
                onChange={onColorChange}
              />
            </Box>
          </FormControl>
        </Stack>
        {/* buttonFlex keeps the lone action button-sized (DialogActions stretches children
            to fill by default) and right-aligned, per dialog conventions. */}
        <DialogActions buttonFlex="0 1 auto" sx={{ pt: 1, justifyContent: 'flex-end' }}>
          <Button type="button" variant="plain" color="neutral" onClick={revertAndClose}>Cancel</Button>
          {/* A slot with no preset would be dropped from the slice request, so this cannot
              confirm one: the user picks a preset or cancels back to what was there. In 'add'
              mode that is also what stops a slot existing before its material is chosen. */}
          <Button type="button" onClick={() => onClose('done')} disabled={!compatibleSelection} sx={{ minWidth: 96 }}>
            {mode === 'add' ? 'Add' : 'Done'}
          </Button>
        </DialogActions>
      </ModalDialog>
    </BackAwareModal>
  )
}
