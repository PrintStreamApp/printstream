/**
 * Brand-aware filament-preset picker shared by material editing and calibration.
 * It renders the literal preset identity, Bambu brand mark, source grouping, and
 * compatibility metadata from `SliceMaterialOption`; callers narrow the options
 * to the material and hardware context before rendering it.
 */
import { useEffect, useState } from 'react'
import { AutocompleteOption, Box, ListItemContent, Stack, Typography } from '@mui/joy'
import { PresetNameWithBrandMark } from '../BambuBrandMark'
import { DeferredKeyboardAutocomplete } from '../DeferredKeyboardAutocomplete'
import {
  filterSliceMaterialOptions,
  isSourceOnlyPresetMetadata,
  type SliceMaterialOption
} from '../../lib/slicingPresetMatching'

/** The literal preset name an option binds to, or null for an unresolved loaded material. */
function literalPresetName(option: SliceMaterialOption): string | null {
  if (!option.material) return null
  return option.source === 'manual' || option.profileId ? option.material : null
}

export function MaterialPresetAutocomplete({
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
  // The field names the literal preset in effect, while rows use the shorter alias where their
  // group and brand treatment provide context. This keeps machine variants distinguishable.
  const displayValue = value ? literalPresetName(value) ?? value.presetLabel ?? value.label : ''
  const [inputValue, setInputValue] = useState(displayValue)

  useEffect(() => {
    setInputValue(displayValue)
  }, [value?.id, displayValue])

  return (
    <DeferredKeyboardAutocomplete
      options={options}
      value={value}
      inputValue={inputValue}
      onChange={(_event, option) => onChange(option ?? null)}
      onInputChange={(_event, nextValue, reason) => {
        if (reason === 'reset') return
        setInputValue(nextValue)
      }}
      getOptionLabel={(option) => option.label}
      // Search the whole identity, including vendor and literal preset name, rather than only the
      // alias visible in a grouped option row.
      filterOptions={(available, state) => filterSliceMaterialOptions(available, state.inputValue, displayValue)}
      isOptionEqualToValue={(option, selected) => option?.id === selected?.id}
      groupBy={(option) => option.group}
      placeholder={placeholder}
      selectOnFocus
      handleHomeEndKeys
      openOnFocus
      slotProps={{ listbox: { sx: { maxHeight: 360 } } }}
      renderOption={(props, option) => {
        const preset = literalPresetName(option)
        const primary = option.source === 'manual' ? preset ?? option.label : option.label
        const secondary = option.source === 'manual'
          ? (isSourceOnlyPresetMetadata(option.metadata) ? '' : option.metadata)
          : [option.brand, option.metadata].filter(Boolean).join(' · ')

        return (
          <AutocompleteOption {...props} key={option.id}>
            <ListItemContent>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                <Box sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: option.color ?? 'neutral.500', border: '1px solid', borderColor: 'divider', flexShrink: 0 }} />
                <Stack spacing={0.35} sx={{ minWidth: 0 }}>
                  <Typography level="body-sm" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <PresetNameWithBrandMark name={primary} />
                  </Typography>
                  {secondary && <Typography level="body-xs" textColor="text.tertiary">{secondary}</Typography>}
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
