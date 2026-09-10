/**
 * Email opt-in contributed to the account page's Notifications section.
 *
 * Rides the same slot as browser push because it is the same kind of state:
 * a personal delivery choice every member owns. Its API was already open to
 * any signed-in member; only the admin-only screen hosting it was not.
 *
 * Hidden at the platform scope for a non-platform user, where the API answers
 * 401 (`assertPlatformScopeActor`). The panel cannot tell that apart from a
 * failed status read and would render "Email delivery isn't configured yet,
 * configure an SMTP server" over a permanently disabled switch, which blames
 * the install for a permission answer.
 */
import MailOutlineRoundedIcon from '@mui/icons-material/MailOutlineRounded'
import { AccountNotificationChannelCard } from '../../components/AccountNotificationChannelCard'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { scopeAcceptsPersonalNotifications } from '../../lib/personalNotificationScope'
import { EmailNotificationsPanel } from './EmailNotificationsPanel'

export function EmailNotificationsAccountSection() {
  const bootstrap = useAuthBootstrapQuery().data
  if (!scopeAcceptsPersonalNotifications(bootstrap)) return null

  return (
    <AccountNotificationChannelCard icon={<MailOutlineRoundedIcon />} title="Email">
      <EmailNotificationsPanel />
    </AccountNotificationChannelCard>
  )
}
