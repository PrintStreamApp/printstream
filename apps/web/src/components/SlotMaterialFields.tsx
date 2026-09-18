/** Free-entry physical identity used by manual AMS and external-spool assignments. */
import { FormControl, FormLabel, Stack } from '@mui/joy'
import type { SlotMaterialIdentity } from '@printstream/shared'
import { DeferredKeyboardAutocomplete } from './DeferredKeyboardAutocomplete'
import { FILAMENT_BRAND_SUGGESTIONS, FILAMENT_MATERIAL_SUGGESTIONS, FILAMENT_PRODUCT_LINE_SUGGESTIONS } from '../lib/filamentSuggestions'

const fields = [
  ['brand', 'Brand', FILAMENT_BRAND_SUGGESTIONS],
  ['filamentType', 'Material type', FILAMENT_MATERIAL_SUGGESTIONS],
  ['materialSubtype', 'Product line', FILAMENT_PRODUCT_LINE_SUGGESTIONS],
  ['colorName', 'Colour name (optional)', []]
] as const

/** Suggestions help entry but never constrain the user's filament identity to printer presets. */
export function SlotMaterialFields({ value, onChange }: {
  value: SlotMaterialIdentity
  onChange: (value: SlotMaterialIdentity) => void
}) {
  return (
    <Stack spacing={1}>
      {fields.map(([field, label, options]) => (
        <FormControl key={field} required={field === 'filamentType'}>
          <FormLabel>{label}</FormLabel>
          <DeferredKeyboardAutocomplete
            freeSolo
            forcePopupIcon={options.length > 0}
            openOnFocus
            selectOnFocus
            handleHomeEndKeys
            options={[...options].sort((left, right) => left.localeCompare(right))}
            inputValue={value[field] ?? ''}
            onInputChange={(_event, text, reason) => {
              if (reason !== 'reset') onChange({ ...value, [field]: text })
            }}
            onChange={(_event, text) => onChange({ ...value, [field]: text ?? '' })}
          />
        </FormControl>
      ))}
    </Stack>
  )
}
