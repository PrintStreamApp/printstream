/** Suggestion-board adapters for the self-hosted cloud-connection plugin. */
import { Alert } from '@mui/joy'
import { SuggestionsMenuItem } from '../../components/suggestions/SuggestionsMenuItem'
import { SuggestionsView } from '../../components/suggestions/SuggestionsView'
import { ListSkeleton } from '../../components/ListSkeleton'
import { useCloudSuggestionEligibility } from './useCloudFeatureEligibility'

const SELF_HOSTED_SUGGESTIONS_BASE = '/api/plugins/cloud-connection/suggestions'

export function SelfHostedSuggestionsMenuItem() {
  // Keep the entry visible so an invalid or unreadable key gets a clear reason
  // on the board instead of making Suggestions silently disappear.
  return <SuggestionsMenuItem />
}

export function SelfHostedSuggestionsView() {
  const eligible = useCloudSuggestionEligibility()
  if (eligible === undefined) return <ListSkeleton rows={2} />
  if (!eligible.eligible) {
    return <Alert color="warning" variant="soft">{eligible.reason}</Alert>
  }
  return <SuggestionsView apiBase={SELF_HOSTED_SUGGESTIONS_BASE} />
}
