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
import { PresetNameWithBrandMark } from '../BambuBrandMark'
import { DeferredKeyboardAutocomplete } from '../DeferredKeyboardAutocomplete'
import { FilamentColorPicker } from './FilamentColorPicker'
import { filterSliceMaterialOptions, isSourceOnlyPresetMetadata, type SliceMaterialOption } from '../../lib/slicingPresetMatching'

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
            {/* No literal-preset helper line here: the field itself now carries that name, so
                repeating it underneath said the same thing twice. */}
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

/**
 * The literal preset name an option binds to ("Bambu PLA Basic @BBL P1S 0.4 nozzle"), or null when
 * the option does not name one.
 *
 * Shared by the field and the option rows so the two cannot disagree about which text is the
 * preset. A CATALOGUE option's `material` is always the preset's own name. A LOADED option (an AMS
 * tray, a tracked spool) only has one when a preset actually resolved for it: otherwise `material`
 * falls back to the bare filament type ("PLA"), and showing that would replace the spool's own name
 * with something less specific than what the user is pointing at.
 */
function literalPresetName(option: SliceMaterialOption): string | null {
  if (!option.material) return null
  return option.source === 'manual' || option.profileId ? option.material : null
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
  // The FIELD names the LITERAL preset in effect ("Bambu PLA Basic @BBL P1S 0.4 nozzle"), not its
  // alias. Two reasons. Choosing a loaded filament ("Michael's PLA") sets type/preset/colour, and
  // the field must read as the matched preset rather than the spool, BambuStudio-style. And the
  // alias is the SAME text for every machine variant of a product (and for a workspace preset
  // derived from a built-in), so it cannot answer "which preset am I actually bound to?" -- the
  // question a user checks this field for once the dialog has closed. The alias still labels the
  // option rows below, where the choice is made and the grouping supplies the vendor.
  const displayValue = value ? literalPresetName(value) ?? value.presetLabel ?? value.label : ''
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
      renderOption={(props, option) => {
        // A CATALOGUE row leads with the literal preset name. It used to lead with the alias and
        // carry the real name on a third line, which spent the most prominent line on the text that
        // identifies the preset LEAST: the alias is identical for every machine variant of a
        // product and for a workspace preset derived from it, so the line that actually told the
        // variants apart was the smallest and last.
        //
        // A LOADED row still leads with the filament: its `label` is the spool the user is pointing
        // at ("Michael's PLA"), not a short form of anything, and its preset keeps the line below.
        const preset = literalPresetName(option)
        const primary = option.source === 'manual' ? preset ?? option.label : option.label
        // The second line survives only where it says something the row does not already. On a
        // CATALOGUE row the brand now leads the primary line ("Bambu PLA Tough+ @BBL X1C") and the
        // source ("System preset") is what the GROUP HEADER above it says, so both were repetition;
        // real metadata (nozzle sizes, plate types, conditional compatibility) still earns the line.
        // A LOADED row keeps brand and metadata outright: that is its slot and colour.
        const secondary = option.source === 'manual'
          ? (isSourceOnlyPresetMetadata(option.metadata) ? '' : option.metadata)
          : [option.brand, option.metadata].filter(Boolean).join(' · ')
        return (
          <AutocompleteOption {...props} key={option.id}>
            <ListItemContent>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                <Box sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: option.color ?? 'neutral.500', border: '1px solid', borderColor: 'divider', flexShrink: 0 }} />
                <Stack spacing={0.35} sx={{ minWidth: 0 }}>
                  {/* The vendor prefix becomes Bambu's mark, as BambuStudio's filament picker does
                      it. Rows only: the FIELD is a real text input, whose value cannot carry an
                      element, and which has the whole dialog width to itself anyway. */}
                  <Typography level="body-sm" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <PresetNameWithBrandMark name={primary} />
                  </Typography>
                  {secondary && <Typography level="body-xs" textColor="text.tertiary">{secondary}</Typography>}
                  {/* Only where it still says something the first line does not: a loaded row. */}
                  {preset && preset !== primary && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {preset}
                    </Typography>
                  )}
                </Stack>
              </Stack>
            </ListItemContent>
          </AutocompleteOption>
        )
      }}
    />
  )
}
