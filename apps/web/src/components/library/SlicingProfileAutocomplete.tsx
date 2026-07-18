/**
 * The grouped slicing-profile picker (process/machine presets) shared by the slice settings
 * panel and the process-settings dialog's profile switcher. Groups options the Bambu way
 * (3MF project profiles / Workspace profiles / Built-in profiles — group band styling comes
 * from `DeferredKeyboardAutocomplete`), keeps option names on ONE line (ellipsized), and
 * surfaces the full preset name via tooltips — on each option and on the selected value —
 * because real preset names ("0.20mm Balanced Strength @BBL H2D - Ryan") routinely outgrow
 * the control.
 */
import { useEffect, useState } from 'react'
import { AutocompleteOption, Box, ListItemContent, Tooltip, Typography } from '@mui/joy'
import { createFilterOptions } from '@mui/joy/Autocomplete'
import type { SlicingProfileSummary } from '@printstream/shared'
import { DeferredKeyboardAutocomplete } from '../DeferredKeyboardAutocomplete'
import { formatSlicingProfileDisplayName, isProjectSlicingProfileId } from '../../lib/slicingProfileSelection'

const filterByDisplayName = createFilterOptions<SlicingProfileSummary>({
  stringify: formatSlicingProfileDisplayName
})

export function SlicingProfileAutocomplete({
  profiles,
  value,
  placeholder,
  ariaLabel,
  modified,
  onChange
}: {
  profiles: SlicingProfileSummary[]
  value: SlicingProfileSummary | null
  placeholder: string
  ariaLabel?: string
  /** When true, prefixes the selected name with `*` (Bambu's "modified" marker). */
  modified?: boolean
  onChange: (profile: SlicingProfileSummary | null) => void
}) {
  const valueDisplayName = value ? `${modified ? '* ' : ''}${formatSlicingProfileDisplayName(value)}` : ''
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
          value={value}
          inputValue={inputValue}
          onChange={(_event, profile) => onChange(profile)}
          onInputChange={(_event, nextValue, reason) => {
            if (reason === 'reset') return
            setInputValue(nextValue)
          }}
          getOptionLabel={formatSlicingProfileDisplayName}
          // Opening with the committed selection must show the FULL catalog (select-like
          // semantics): the input carries the selected name — with the '* ' modified marker it
          // no longer equals the option label, so the default filter would narrow the list to
          // the chosen option and the user couldn't browse without clearing the field first.
          // Once the user actually edits the text, normal type-to-filter resumes.
          filterOptions={(options, state) => (
            value && state.inputValue === valueDisplayName ? options : filterByDisplayName(options, state)
          )}
          isOptionEqualToValue={(option, selected) => option.id === selected.id}
          groupBy={(profile) => isProjectSlicingProfileId(profile.id) ? '3MF project profiles' : profile.source === 'custom' ? 'Workspace profiles' : 'Built-in profiles'}
          placeholder={placeholder}
          selectOnFocus
          handleHomeEndKeys
          openOnFocus
          slotProps={{
            input: ariaLabel ? { 'aria-label': ariaLabel } : undefined,
            listbox: { sx: { maxHeight: 360 } }
          }}
          renderOption={(props, profile) => (
            <AutocompleteOption {...props} key={profile.id}>
              <ListItemContent sx={{ minWidth: 0 }}>
                {/* One line per preset (wrapping made the list hard to scan); the tooltip
                    carries the full name for anything the ellipsis cuts off. */}
                <Tooltip title={formatSlicingProfileDisplayName(profile)} disableInteractive placement="right">
                  <Typography level="body-sm" noWrap>{formatSlicingProfileDisplayName(profile)}</Typography>
                </Tooltip>
              </ListItemContent>
            </AutocompleteOption>
          )}
        />
      </Box>
    </Tooltip>
  )
}
