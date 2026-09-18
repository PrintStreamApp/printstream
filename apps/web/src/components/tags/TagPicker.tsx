/** Searchable grouped tag picker shared by filter facets and assignment forms. */
import { Autocomplete, AutocompleteOption, ListItemDecorator, Chip, FormControl, FormLabel } from '@mui/joy'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import CircleIcon from '@mui/icons-material/Circle'
import { compareTags, type WorkspaceTag } from '@printstream/shared'
import { useMemo } from 'react'

export function TagPicker({ tags, value, onChange, label = 'Tags', disabled = false }: {
  tags: WorkspaceTag[]
  value: string[]
  onChange: (ids: string[]) => void
  label?: string
  disabled?: boolean
}) {
  const options = useMemo(() => [...tags].sort(compareTags), [tags])
  return (
    <FormControl>
      <FormLabel>{label}</FormLabel>
      <Autocomplete
        multiple disableCloseOnSelect slotProps={{ listbox: { disablePortal: true } }} size="sm" disabled={disabled}
        options={options} value={options.filter((tag) => value.includes(tag.id))}
        onChange={(_event, selected) => onChange(selected.map((tag) => tag.id))}
        getOptionLabel={(tag) => tag.name}
        groupBy={(tag) => tag.group || 'Ungrouped'}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        placeholder="Search tags"
        renderOption={(props, tag, { selected }) => (
          <AutocompleteOption {...props} key={tag.id}>
            <ListItemDecorator>{selected ? <CheckRoundedIcon fontSize="small" /> : null}</ListItemDecorator>
            <CircleIcon style={{ color: tag.color, fontSize: 12 }} />{tag.name}
          </AutocompleteOption>
        )}
        renderTags={(selected, getTagProps) => selected.map((tag, index) => (
          <Chip {...getTagProps({ index })} key={tag.id} size="sm" sx={{ maxWidth: '100%' }} startDecorator={<CircleIcon style={{ color: tag.color, fontSize: 10 }} />}>{tag.name}</Chip>
        ))}
      />
    </FormControl>
  )
}
