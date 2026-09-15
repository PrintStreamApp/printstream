/** Privacy and entitlement status for the self-hosted cloud connection. */
import { Alert, Stack, Typography } from '@mui/joy'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'

interface CloudConnectionStatus {
  eligible: boolean
  reason: string | null
}

export function CloudConnectionSettingsPanel() {
  const query = useQuery({
    queryKey: ['plugin-settings', 'cloud-connection'],
    queryFn: ({ signal }) => apiFetch<CloudConnectionStatus>('/api/plugins/cloud-connection/status', { signal })
  })

  return (
    <Stack spacing={1.25}>
      <Typography level="body-sm" textColor="text.tertiary">
        This connection is enabled by default and can be disabled from the plugin manager. In-app
        support sends messages, attachments, workspace name and identifier, current page, app build,
        browser details, license key, and installation ID to PrintStream Cloud. Support and
        Suggestions use the license owner's identity; unread support replies are emailed to that
        account. The license and installation fingerprint remain private operator context. The
        install makes no background cloud requests.
      </Typography>
      {query.data && (
        <Alert color={query.data.eligible ? 'success' : 'warning'} variant="soft">
          {query.data.eligible ? 'This license includes in-app support and suggestions.' : query.data.reason}
        </Alert>
      )}
    </Stack>
  )
}
