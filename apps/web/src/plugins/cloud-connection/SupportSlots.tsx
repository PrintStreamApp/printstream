/** Self-hosted support slot adapters for the cloud-connection plugin. */
import { Alert } from '@mui/joy'
import {
  AccountMessagesSection,
  type AccountMessagesPresentation
} from '../../components/support/AccountMessagesSection'
import { HelpDialogConversations } from '../../components/support/HelpDialogConversations'
import { useCloudSupportEligibility } from './useCloudSupportEligibility'

export const SELF_HOSTED_SUPPORT_BASE = '/api/plugins/cloud-connection/support'

export function SelfHostedAccountMessagesSection({ presentation }: { presentation?: AccountMessagesPresentation }) {
  const eligible = useCloudSupportEligibility()
  if (eligible === undefined) return null
  if (!eligible) {
    return <Alert color="warning" variant="soft">In-app messages require a commercial license with current updates and support.</Alert>
  }
  return <AccountMessagesSection base={SELF_HOSTED_SUPPORT_BASE} presentation={presentation} />
}

export function SelfHostedHelpDialogConversations() {
  return <HelpDialogConversations base={SELF_HOSTED_SUPPORT_BASE} />
}
