/**
 * Status chip for suggestion board posts.
 */
import { Chip } from '@mui/joy'
import { suggestionStatusLabels, type SuggestionStatus } from '@printstream/shared'
import { SUGGESTION_STATUS_COLORS } from './suggestionStatusColors'

export function SuggestionStatusChip({ status }: { status: SuggestionStatus }) {
  return (
    <Chip size="sm" variant="soft" color={SUGGESTION_STATUS_COLORS[status]}>
      {suggestionStatusLabels[status]}
    </Chip>
  )
}
