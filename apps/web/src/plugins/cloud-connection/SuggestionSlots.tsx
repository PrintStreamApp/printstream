/** Suggestion-board adapters for the self-hosted cloud-connection plugin. */
import { Alert } from '@mui/joy'
import { SuggestionsMenuItem } from '../../components/suggestions/SuggestionsMenuItem'
import { SuggestionsView } from '../../components/suggestions/SuggestionsView'
import { ListSkeleton } from '../../components/ListSkeleton'
import { useCloudSupportEligibility } from './useCloudSupportEligibility'

const SELF_HOSTED_SUGGESTIONS_BASE = '/api/plugins/cloud-connection/suggestions'

export function SelfHostedSuggestionsMenuItem() {
  const eligible = useCloudSupportEligibility()
  return eligible ? <SuggestionsMenuItem /> : null
}

export function SelfHostedSuggestionsView() {
  const eligible = useCloudSupportEligibility()
  if (eligible === undefined) return <ListSkeleton rows={2} />
  if (!eligible) {
    return <Alert color="warning" variant="soft">Suggestions require a commercial license with current updates and support.</Alert>
  }
  return <SuggestionsView apiBase={SELF_HOSTED_SUGGESTIONS_BASE} />
}
