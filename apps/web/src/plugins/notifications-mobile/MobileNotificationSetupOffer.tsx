/** Optional native onboarding, using the same dialog shell as other account setup. */
import { Button, Checkbox, Stack, Typography } from '@mui/joy'
import { FormDialog } from '../../components/FormDialog'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { useMobileNotificationOffer } from './useMobileNotificationOffer'
import { openAndroidNotificationSettings } from '../../native/notifications'
import { ProgressSpinner } from '../../components/ProgressSpinner'

export function MobileNotificationSetupOffer() {
  const bootstrap = useAuthBootstrapQuery().data
  const offer = useMobileNotificationOffer(bootstrap)

  // Keep the dialog mounted while closing on a scope change so its Back entry
  // is released by the normal closed-state lifecycle.
  return <FormDialog
    open={offer.open}
    title={offer.manual ? 'App settings: Notifications' : 'Get notifications?'}
    description="Choose what sends alerts to this phone."
    submitLabel="Save"
    cancelLabel={offer.manual ? 'Cancel' : 'Not now'}
    busy={offer.busy}
    submitDisabled={offer.loading || offer.choices.length === 0}
    error={offer.error}
    onClose={offer.dismiss}
    onSubmit={() => void offer.enable()}
  >
    {offer.loading && <ProgressSpinner size="sm" aria-label="Loading notification settings" />}
    <Stack spacing={2}>
      {offer.choices.map((choice) => <Stack key={choice.id} spacing={0.5}>
        <Checkbox label={choice.name} checked={choice.selected}
          disabled={offer.busy || (!choice.available && !choice.enabled)}
          onChange={(event) => offer.select(choice.id, event.target.checked)} />
        {!choice.available && <Typography level="body-sm">Notifications are unavailable on this workspace right now.</Typography>}
      </Stack>)}
    </Stack>
    {offer.choices.some((choice) => !choice.permission) && <Button size="sm" variant="plain"
      onClick={() => void openAndroidNotificationSettings().catch(() => console.warn('Could not open Android notification settings.'))}>
      Android notification settings
    </Button>}
    <Typography level="body-sm">Only this phone is affected. Change these choices anytime in App settings.</Typography>
    {bootstrap?.runtimePolicy.selfHosted
      ? <Typography level="body-sm">Delivered through Google. If your server uses PrintStream's relay, PrintStream Cloud receives your device token and an opaque device handle. Notification text, routes, and image links are encrypted for this phone before they leave your server. Camera files stay on your server.</Typography>
      : <Typography level="body-sm">Delivered through Google's push service.</Typography>}
  </FormDialog>
}
