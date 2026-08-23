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
import { useEffect, useRef, useState } from 'react'
import {
  AutocompleteOption, Box, Button, DialogActions, FormControl, FormHelperText, FormLabel,
  ListItemContent, ModalDialog, Option, Select, Stack, Typography
} from '@mui/joy'
import { BackAwareModal } from '../BackAwareModal'
import { DeferredKeyboardAutocomplete } from '../DeferredKeyboardAutocomplete'
import { FilamentColorPicker } from './FilamentColorPicker'
import { filterSliceMaterialOptions, type SliceMaterialOption } from '../../lib/slicingPresetMatching'

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
              // Switching type clears the preset: the old pick belongs to the previous
              // material and is no longer in the narrowed list, so leaving it selected
              // shows a preset that contradicts the type above it. Done stays disabled
              // until a preset from the new type is chosen.
              onChange={(_event, value) => {
                const nextType = value ?? ''
                if (nextType === typeFilter) return
                onTypeFilterChange(nextType)
                if (selectedOption && selectedOption.materialType !== nextType) onMaterialOptionChange(null)
              }}
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
            {/* The field shows the ALIAS, which is the same text for every variant of a product,
                including a workspace preset derived from a built-in. Reading it as confirmation of
                which preset is bound is therefore a mistake the field invites, so name the literal
                preset underneath whenever it says more. The option rows already do this; the field
                is what a user checks after the dialog closes. */}
            {selectedOption?.profileId && selectedOption.material && selectedOption.material !== (selectedOption.presetLabel ?? selectedOption.label) && (
              <FormHelperText sx={{ color: 'text.tertiary' }}>{selectedOption.material}</FormHelperText>
            )}
            {/* Only flag the cases needing the user to act, and always say WHY Done is disabled
                rather than leaving a dead button with no explanation. */}
            {!selectedOption && (
              <FormHelperText sx={{ color: 'warning.400' }}>
                {materialOptions.length > 0
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
          <Button type="button" onClick={() => onClose('done')} disabled={!selectedOption} sx={{ minWidth: 96 }}>
            {mode === 'add' ? 'Add' : 'Done'}
          </Button>
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
  // The FIELD shows the slicing preset actually in effect: choosing a loaded
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
      // "No preset" is a real, reachable state: switching the type clears the previous
      // pick, and a tray whose preset never resolved opens with none. So the field is
      // nullable and clearable; `Done` is what refuses to confirm an empty slot. (This
      // was `disableClearable` with `value ?? undefined` on the assumption that a slot
      // always had a preset; a null value then reached Joy as `undefined` and crashed
      // its option/value diffing.)
      value={value}
      inputValue={inputValue}
      onChange={(_event, option) => onChange(option ?? null)}
      onInputChange={(_event, nextValue, reason) => {
        if (reason === 'reset') return
        setInputValue(nextValue)
      }}
      getOptionLabel={(option) => option.label}
      // Search the whole identity, not just the displayed label. The label is the ALIAS, which has
      // the vendor prefix stripped ("PLA Basic"), so typing a brand matched no built-in preset at
      // all: the reason a separate Brand dropdown was needed, and why removing it in favour of
      // "just type it" did not work. Terms are ANDed so "bambu pla basic" narrows rather than
      // widening, and the literal preset name is searchable too ("@BBL A1" finds that variant).
      filterOptions={(available, state) => filterSliceMaterialOptions(available, state.inputValue, displayValue)}
      // Joy calls this while reconciling an empty/!changing selection, so both sides
      // must tolerate absence rather than assuming a value is always present.
      isOptionEqualToValue={(option, selected) => option?.id === selected?.id}
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
                {/* The LITERAL preset name. The row above shows the alias, which is the same text
                    for every machine variant of a product, so without this there is no way to see
                    which variant a pick actually landed on. Only when it adds something. */}
                {option.profileId && option.material && option.material !== option.label && (
                  <Typography level="body-xs" textColor="text.tertiary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {option.material}
                  </Typography>
                )}
              </Stack>
            </Stack>
          </ListItemContent>
        </AutocompleteOption>
      )}
    />
  )
}
