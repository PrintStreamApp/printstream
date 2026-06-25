/**
 * Option for a multi-value `Select`. Shows a leading check when selected and
 * reserves the decorator space otherwise, so users can tell at a glance that the
 * dropdown accepts multiple selections (and can keep picking more).
 *
 * Pair the parent `Select multiple` with a `renderValue` so the trigger shows a
 * clean summary rather than the check decorators.
 */
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import { ListItemDecorator, Option } from '@mui/joy'
import type { ReactNode } from 'react'

export function MultiSelectOption<T extends string | number>({
  value,
  selected,
  children
}: {
  value: T
  selected: boolean
  children: ReactNode
}) {
  return (
    <Option value={value}>
      <ListItemDecorator>{selected ? <CheckRoundedIcon fontSize="small" /> : null}</ListItemDecorator>
      {children}
    </Option>
  )
}
