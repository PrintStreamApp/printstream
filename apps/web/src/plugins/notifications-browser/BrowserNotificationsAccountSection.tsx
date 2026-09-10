/**
 * Browser push contributed to the account page's Notifications section.
 *
 * The same panel Settings renders, in the one place every member can reach:
 * enrolling THIS browser is per-actor, per-device state, so gating it behind
 * the workspace-configuration screen made background notifications
 * admin-only by accident.
 *
 * Renders nothing where the scope would refuse the enrolment (a signed-in
 * member sitting at the platform scope, which admits platform users only):
 * a card whose only control fails on click is worse than no card.
 */
import NotificationsActiveRoundedIcon from '@mui/icons-material/NotificationsActiveRounded'
import { AccountNotificationChannelCard } from '../../components/AccountNotificationChannelCard'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { scopeAcceptsPersonalNotifications } from '../../lib/personalNotificationScope'
import { BrowserNotificationsPanel } from './BrowserNotificationsPanel'

export function BrowserNotificationsAccountSection() {
  const bootstrap = useAuthBootstrapQuery().data
  if (!scopeAcceptsPersonalNotifications(bootstrap)) return null

  return (
    <AccountNotificationChannelCard icon={<NotificationsActiveRoundedIcon />} title="This device">
      <BrowserNotificationsPanel />
    </AccountNotificationChannelCard>
  )
}
