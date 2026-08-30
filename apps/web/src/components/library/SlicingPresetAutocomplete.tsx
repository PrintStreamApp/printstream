/**
 * The grouped slicing-profile picker (process/machine presets) shared by the slice settings
 * panel and the process-settings dialog's profile switcher. Groups options the Bambu way
 * (3MF project presets / User presets / System presets, group band styling comes
 * from `DeferredKeyboardAutocomplete`), keeps option names on ONE line (ellipsized), and
 * surfaces the full preset name via tooltips, on each option and on the selected value,
 * because real preset names ("0.20mm Balanced Strength @BBL H2D - Ryan") routinely outgrow
 * the control.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AutocompleteOption, Box, ListItemContent, Tooltip, Typography } from '@mui/joy'
import { createFilterOptions } from '@mui/joy/Autocomplete'
import type { SlicingPresetSummary } from '@printstream/shared'
import { DeferredKeyboardAutocomplete } from '../DeferredKeyboardAutocomplete'
import { isProjectSlicingPresetId } from '@printstream/shared'
import { buildSlicingPresetLabels, formatSlicingPresetDisplayName } from '../../lib/slicingPresetSelection'

/**
 * Built per render pass from the CURRENT option list, because a collision is a property of the
 * list, not of a preset: the same preset is labelled plainly in a picker where its alias is unique
 * and by full name in one where it is not.
 */
function makeFilter(label: (profile: SlicingPresetSummary) => string) {
  return createFilterOptions<SlicingPresetSummary>({ stringify: label })
}

export function SlicingPresetAutocomplete({
  profiles,
  value,
  placeholder,
  ariaLabel,
  modified,
  onChange
}: {
  profiles: SlicingPresetSummary[]
  value: SlicingPresetSummary | null
  placeholder: string
  ariaLabel?: string
  /** When true, prefixes the selected name with `*` (Bambu's "modified" marker). */
  modified?: boolean
  onChange: (profile: SlicingPresetSummary | null) => void
}) {
  const labels = useMemo(() => buildSlicingPresetLabels(profiles), [profiles])
  // Falls back to the bare alias for a value that is not in the list (a preset filtered out by the
  // current printer), which has no collision to resolve.
  const labelFor = useCallback(
    (profile: SlicingPresetSummary) => labels.get(profile.id) ?? formatSlicingPresetDisplayName(profile),
    [labels]
  )
  const filterByDisplayName = useMemo(() => makeFilter(labelFor), [labelFor])
  const valueDisplayName = value ? `${modified ? '* ' : ''}${labelFor(value)}` : ''
  const [inputValue, setInputValue] = useState(valueDisplayName)

  useEffect(() => {
    setInputValue(valueDisplayName)
  }, [valueDisplayName])

  return (
    // The wrapper Box is the tooltip anchor: hovering the control reveals the full selected
    // preset name, which the input truncates for anything longer than the control.
    <Tooltip title={valueDisplayName} disableInteractive>
      <Box>
        <DeferredKeyboardAutocomplete
          options={profiles}
          // NULL, not undefined. `disableClearable` narrows Joy's value TYPE to `T`, which tempted
          // a `value ?? undefined`, but undefined is how React spells "uncontrolled", so every time
          // the selection stopped being compatible (any printer-model switch) React logged a
          // controlled→uncontrolled error and reset the input's internal state. Null is a normal
          // controlled "nothing selected" at runtime; only the type objects, hence the cast.
          value={value as SlicingPresetSummary}
          inputValue={inputValue}
          onChange={(_event, profile) => onChange(profile ?? null)}
          onInputChange={(_event, nextValue, reason) => {
            // Joy asks for a 'reset' whenever the popup closes without a pick (Escape, blur,
            // clickaway) and whenever the value changes. Its proposed text is
            // `getOptionLabel(value)`, which DROPS the '* ' modified marker, so the reset is
            // honoured with `valueDisplayName` rather than refused. Refusing it outright is what
            // left an abandoned search sitting in the box: type "Pro", press Escape, and the
            // control read "Pro" while the selection was still the preset it started on, i.e. it
            // named a preset that was never chosen and that a slice would not use.
            if (reason === 'reset') { setInputValue(valueDisplayName); return }
            setInputValue(nextValue)
          }}
          getOptionLabel={labelFor}
          // Opening with the committed selection must show the FULL catalog (select-like
          // semantics): the input carries the selected name, with the '* ' modified marker it
          // no longer equals the option label, so the default filter would narrow the list to
          // the chosen option and the user couldn't browse without clearing the field first.
          // Once the user actually edits the text, normal type-to-filter resumes.
          filterOptions={(options, state) => (
            value && state.inputValue === valueDisplayName ? options : filterByDisplayName(options, state)
          )}
          // `selected` can be undefined: with disableClearable the value is passed as
          // `value ?? undefined`, and Joy still runs this comparator while filtering, which it
          // does exactly when the current selection stops being compatible (switching the printer
          // model to one the selected profile does not support). Optional-chain or it throws
          // mid-render and takes the editor down with it.
          isOptionEqualToValue={(option, selected) => option.id === selected?.id}
          groupBy={(profile) => isProjectSlicingPresetId(profile.id) ? '3MF project presets' : profile.source === 'custom' ? 'User presets' : 'System presets'}
          placeholder={placeholder}
          // There is always a selected profile, a cleared value would leave the slice with no
          // process at all, so drop Joy's clear (x) affordance.
          disableClearable
          selectOnFocus
          handleHomeEndKeys
          openOnFocus
          // Escape abandons the search, and Joy emits no 'reset' for it, so the half-typed text
          // would sit there naming a preset that was never selected until focus happened to move
          // away (blur DOES emit one). Handled through `onClose` rather than a `slotProps.input`
          // key handler, which Autocomplete's own internal `onKeyDown` shadows.
          onClose={(_event, reason) => { if (reason === 'escape') setInputValue(valueDisplayName) }}
          slotProps={{
            input: ariaLabel ? { 'aria-label': ariaLabel } : undefined,
            listbox: { sx: { maxHeight: 360 } }
          }}
          renderOption={(props, profile) => (
            <AutocompleteOption {...props} key={profile.id}>
              <ListItemContent sx={{ minWidth: 0 }}>
                {/* One line per preset (wrapping made the list hard to scan); the tooltip
                    carries the full name for anything the ellipsis cuts off. */}
                <Tooltip title={labelFor(profile)} disableInteractive placement="right">
                  <Typography level="body-sm" noWrap>{labelFor(profile)}</Typography>
                </Tooltip>
              </ListItemContent>
            </AutocompleteOption>
          )}
        />
      </Box>
    </Tooltip>
  )
}
