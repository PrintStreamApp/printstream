/**
 * Platform-admin control for re-triaging a suggestion: a compact select
 * styled like the status chip, listing every suggestion status.
 */
import { Option, Select } from '@mui/joy'
import {
  suggestionStatusLabels,
  suggestionStatusSchema,
  type SuggestionStatus
} from '@printstream/shared'
import { SUGGESTION_STATUS_COLORS } from './suggestionStatusColors'

export function SuggestionStatusSelect({
  status,
  disabled = false,
  onChange
}: {
  status: SuggestionStatus
  disabled?: boolean
  onChange: (status: SuggestionStatus) => void
}) {
  return (
    <Select
      size="sm"
      variant="soft"
      color={SUGGESTION_STATUS_COLORS[status]}
      value={status}
      disabled={disabled}
      aria-label="Suggestion status"
      // The listbox otherwise inherits the (narrow) trigger width and the
      // theme ellipsizes options; size it to its content instead.
      slotProps={{
        listbox: {
          modifiers: [{ name: 'equalWidth', enabled: false }],
          sx: { width: 'max-content' }
        }
      }}
      onChange={(_event, next) => {
        if (next && next !== status) onChange(next)
      }}
    >
      {suggestionStatusSchema.options.map((option) => (
        <Option key={option} value={option}>
          {suggestionStatusLabels[option]}
        </Option>
      ))}
    </Select>
  )
}
