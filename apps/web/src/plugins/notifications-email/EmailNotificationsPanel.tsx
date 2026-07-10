/**
 * Email notifications opt-in panel. Each member toggles whether they receive
 * print notification emails for the current workspace (delivered to their
 * account address). When no email transport is configured the toggle is disabled
 * with a hint (self-hosted operators configure SMTP first).
 */
import { Alert, FormControl, FormLabel, Stack, Switch, Typography } from '@mui/joy'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { extractErrorMessage } from '@printstream/shared'

interface EmailNotificationsStatus {
  emailConfigured: boolean
  subscribed: boolean
}

const QUERY_KEY = ['plugin-settings', 'notifications-email']

export function EmailNotificationsPanel() {
  const queryClient = useQueryClient()
  // The panel renders on both surfaces; the platform workspace (no tenant
  // context) opts into platform events rather than a workspace's print events.
  const isPlatformScope = useAuthBootstrapQuery().data?.tenant == null
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch<EmailNotificationsStatus>('/api/plugins/notifications-email')
  })

  const toggle = useMutation({
    mutationFn: (subscribe: boolean) => apiFetch<{ subscribed: boolean }>('/api/plugins/notifications-email/subscription', {
      method: subscribe ? 'POST' : 'DELETE'
    }),
    onSuccess: (data) => {
      queryClient.setQueryData<EmailNotificationsStatus>(QUERY_KEY, (current) =>
        current ? { ...current, subscribed: data.subscribed } : current)
    }
  })

  const emailConfigured = Boolean(query.data?.emailConfigured)
  const subscribed = Boolean(query.data?.subscribed)
  const error = toggle.error ? extractErrorMessage(toggle.error) : null

  return (
    <Stack spacing={1.25}>
      {!emailConfigured && (
        <Alert color="warning" variant="soft" startDecorator={<InfoOutlinedIcon />}>
          Email delivery isn&apos;t configured yet. Configure an SMTP server (Settings &rarr; Plugins &rarr; SMTP) to receive these emails.
        </Alert>
      )}

      {error && (
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{error}</Alert>
      )}

      <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between', gap: 2, alignItems: 'center' }}>
        <Stack spacing={0.25} sx={{ minWidth: 0 }}>
          <FormLabel sx={{ m: 0 }}>{isPlatformScope ? 'Email me platform notifications' : 'Email me print notifications'}</FormLabel>
          <Typography level="body-xs" textColor="text.tertiary">
            {isPlatformScope
              ? 'Sent to your account email for platform events.'
              : "Sent to your account email for this workspace's print events."}
          </Typography>
        </Stack>
        <Switch
          checked={subscribed}
          disabled={!emailConfigured || query.isLoading || toggle.isPending}
          onChange={(event) => toggle.mutate(event.target.checked)}
        />
      </FormControl>
    </Stack>
  )
}
