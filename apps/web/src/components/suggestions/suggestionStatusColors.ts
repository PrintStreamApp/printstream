/**
 * Suggestion status → Joy color mapping, shared by the status chip and the
 * admin status selector. Labels come from the shared contract
 * (`suggestionStatusLabels`) so notification copy and UI agree.
 */
import type { ColorPaletteProp } from '@mui/joy'
import type { SuggestionStatus } from '@printstream/shared'

export const SUGGESTION_STATUS_COLORS: Record<SuggestionStatus, ColorPaletteProp> = {
  open: 'neutral',
  investigating: 'warning',
  planned: 'primary',
  'in-progress': 'primary',
  completed: 'success',
  declined: 'neutral',
  'not-possible': 'danger'
}
