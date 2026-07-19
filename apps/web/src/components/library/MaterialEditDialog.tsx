/**
 * Material edit dialog — the expanded type/preset/color inputs for ONE material slot,
 * opened by clicking the material's compact swatch row in `SliceSettingsPanel` (the row
 * itself keeps only the swatch + nozzle picker). Edits apply immediately through the
 * slice controller's setters — the same live semantics the inputs had when they sat
 * inline on the row — so "Done" only closes; there is no separate apply/cancel state.
 * "Choose from printer" opens the host slice dialog's printer-material picker Modal,
 * which stacks above this dialog and closes itself after a pick.
 */
import { useEffect, useRef, useState } from 'react'
import {
  AutocompleteOption, Box, Button, DialogActions, FormControl, FormHelperText, FormLabel,
  ListItemContent, ModalDialog, Option, Select, Stack, Typography
} from '@mui/joy'
import { BackAwareModal } from '../BackAwareModal'
import { DeferredKeyboardAutocomplete } from '../DeferredKeyboardAutocomplete'
import { FilamentColorPicker } from './FilamentColorPicker'
import type { SliceMaterialOption } from '../../lib/sliceProfileMatching'

export function MaterialEditDialog({
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
  chooseFromPrinter,
  onClose
}: {
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
  /** Present only when a real printer is targeted (the shortcut needs loaded trays). */
  chooseFromPrinter: { disabled: boolean; onOpen: () => void } | null
  onClose: () => void
}) {
  // Edits apply LIVE through the controller (that is what keeps the editor's dirty flag and undo
  // history correct, and what lets the "Choose from printer" picker write straight through). So
  // Cancel restores the values the dialog opened with rather than staging edits until Done —
  // same outcome for the user, without diverging from that live-apply contract.
  const opened = useRef({ option: selectedOption, color, typeFilter })
  const revertAndClose = () => {
    const initial = opened.current
    if (initial.typeFilter !== typeFilter) onTypeFilterChange(initial.typeFilter)
    if (initial.option?.id !== selectedOption?.id) onMaterialOptionChange(initial.option)
    if (initial.color !== color) onColorChange(initial.color)
    onClose()
  }
  return (
    <BackAwareModal open onClose={revertAndClose}>
      <ModalDialog sx={{ maxWidth: 420, width: '100%' }}>
        <Typography level="h4">Material {filamentIndex + 1}</Typography>
        <Stack spacing={1.25}>
          {chooseFromPrinter && (
            <Button
              type="button"
              variant="outlined"
              color="neutral"
              disabled={chooseFromPrinter.disabled}
              onClick={chooseFromPrinter.onOpen}
            >
              Choose from printer
            </Button>
          )}
          <FormControl>
            <FormLabel>Type</FormLabel>
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
              onChange={(_event, value) => onTypeFilterChange(value ?? '')}
            >
              <Option value="">All material types</Option>
              {typeOptions.map((option) => <Option key={option} value={option}>{option}</Option>)}
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel>Preset</FormLabel>
            <SliceMaterialAutocomplete
              options={materialOptions}
              value={selectedOption}
              placeholder="Choose a material profile"
              onChange={onMaterialOptionChange}
            />
            {/* The field itself shows the preset in effect; only flag the case
                where a loaded filament resolved to NO preset at all. */}
            {selectedOption && selectedOption.source !== 'manual' && !selectedOption.profileId && (
              <FormHelperText sx={{ color: 'warning.400' }}>
                No preset matches this filament — pick one from the list.
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
          <Button type="button" onClick={onClose} sx={{ minWidth: 96 }}>Done</Button>
        </DialogActions>
      </ModalDialog>
    </BackAwareModal>
  )
}

function SliceMaterialAutocomplete({
  options,
  value,
  placeholder,
  onChange
}: {
  options: SliceMaterialOption[]
  value: SliceMaterialOption | null
  placeholder: string
  onChange: (option: SliceMaterialOption | null) => void
}) {
  // The FIELD shows the slicing preset actually in effect — choosing a loaded
  // filament ("Michael's PLA") sets type/preset/colour and the field reads the
  // matched preset ("PLA Basic - Custom"), BambuStudio-style. The filament name
  // still labels the option rows below, where the choice is made.
  const displayValue = value ? value.presetLabel ?? value.label : ''
  const [inputValue, setInputValue] = useState(displayValue)

  useEffect(() => {
    setInputValue(displayValue)
  }, [value?.id, displayValue])

  return (
    <DeferredKeyboardAutocomplete
      options={options}
      // A material slot always resolves to a preset — clearing it would leave the slot with no
      // material at all — so drop Joy's clear (x) affordance.
      disableClearable
      value={value ?? undefined}
      inputValue={inputValue}
      onChange={(_event, option) => onChange(option ?? null)}
      onInputChange={(_event, nextValue, reason) => {
        if (reason === 'reset') return
        setInputValue(nextValue)
      }}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      groupBy={(option) => option.group}
      placeholder={placeholder}
      selectOnFocus
      handleHomeEndKeys
      openOnFocus
      slotProps={{ listbox: { sx: { maxHeight: 360 } } }}
      renderOption={(props, option) => (
        <AutocompleteOption {...props} key={option.id}>
          <ListItemContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Box sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: option.color ?? 'neutral.500', border: '1px solid', borderColor: 'divider', flexShrink: 0 }} />
              <Stack spacing={0.35} sx={{ minWidth: 0 }}>
                <Typography level="body-sm" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{option.label}</Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  {[option.brand, option.metadata].filter(Boolean).join(' · ')}
                </Typography>
              </Stack>
            </Stack>
          </ListItemContent>
        </AutocompleteOption>
      )}
    />
  )
}
