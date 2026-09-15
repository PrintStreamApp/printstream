/**
 * Up/down vote control for a suggestion: two arrows around the current score.
 * Clicking the arrow matching the user's current vote clears it; clicking the
 * other arrow switches it.
 */
import { IconButton, Stack, Typography } from '@mui/joy'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowUpRoundedIcon from '@mui/icons-material/KeyboardArrowUpRounded'
import type { SuggestionVoteValue } from '@printstream/shared'

export function VoteButtons({
  score,
  myVote,
  disabled = false,
  onVote
}: {
  score: number
  myVote: SuggestionVoteValue
  disabled?: boolean
  onVote: (value: SuggestionVoteValue) => void
}) {
  return (
    // Stop propagation at the column so voting inside a clickable row never
    // triggers the row's own click (covers disabled buttons too).
    <Stack spacing={0} alignItems="center" sx={{ minWidth: 40 }} onClick={(event) => event.stopPropagation()}>
      <IconButton
        size="sm"
        variant={myVote === 1 ? 'soft' : 'plain'}
        color={myVote === 1 ? 'primary' : 'neutral'}
        aria-label={myVote === 1 ? 'Remove upvote' : 'Upvote'}
        disabled={disabled}
        onClick={() => onVote(myVote === 1 ? 0 : 1)}
      >
        <KeyboardArrowUpRoundedIcon />
      </IconButton>
      <Typography level="title-sm" aria-label={`Score ${score}`}>{score}</Typography>
      <IconButton
        size="sm"
        variant={myVote === -1 ? 'soft' : 'plain'}
        color={myVote === -1 ? 'danger' : 'neutral'}
        aria-label={myVote === -1 ? 'Remove downvote' : 'Downvote'}
        disabled={disabled}
        onClick={() => onVote(myVote === -1 ? 0 : -1)}
      >
        <KeyboardArrowDownRoundedIcon />
      </IconButton>
    </Stack>
  )
}
