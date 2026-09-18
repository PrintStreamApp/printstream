/** Labels each catalog explicitly so identical tag names remain distinguishable in history. */
import { Fragment } from 'react'
import { Typography } from '@mui/joy'
import type { TagFilter } from '../../hooks/useTagFilter'
import { TagPicker } from './TagPicker'

export function JobHistoryTagFilters({ filters, onChange }: {
  filters: Array<{ label: string; filter: Pick<TagFilter, 'tags' | 'value' | 'onChange' | 'isPending' | 'isError'> }>
  onChange: () => void
}) {
  return <>
    {filters.map(({ label, filter }) => <Fragment key={label}>
      <TagPicker label={label} tags={filter.tags} value={filter.value} disabled={filter.isPending}
        onChange={(ids) => { onChange(); filter.onChange(ids) }} />
      {filter.isError && <Typography color="danger" level="body-sm">Could not load {label.toLowerCase()}.</Typography>}
    </Fragment>)}
  </>
}
