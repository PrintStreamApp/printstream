import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { Alert, Card, CardContent, Chip, Stack, Typography } from '@mui/joy'
import { getPluginDisplayName } from '../lib/pluginSettings'
import { useNotificationChannelEntries } from '../hooks/useNotificationChannelEntries'

export function NotificationChannelsPanel({
  description = 'Configure how each device or destination receives print alerts. Browser push is per device, while Discord and ntfy deliver through their configured destinations.'
}: {
  /** Section intro copy; the default describes the tenant print channels. */
  description?: string
} = {}) {
  const { pluginCatalogQuery, channels } = useNotificationChannelEntries()

  return (
    <Stack spacing={1.5}>
      <Typography level="body-sm" textColor="text.tertiary">
        {description}
      </Typography>
      <Alert color="primary" variant="soft" startDecorator={<InfoOutlinedIcon />}>
        Channel availability reflects installed plugins on this host plus any device-specific setup each channel requires.
      </Alert>
      {pluginCatalogQuery.isLoading && <Typography level="body-sm">Loading channels…</Typography>}
      {pluginCatalogQuery.error && (
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
          {(pluginCatalogQuery.error as Error).message}
        </Alert>
      )}
      {!pluginCatalogQuery.isLoading && !pluginCatalogQuery.error && channels.length === 0 && (
        <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
          No notification plugins are enabled. Enable at least one notification plugin in Plugins to send alerts.
        </Alert>
      )}
      {channels.map((entry) => {
        const Panel = entry.web?.settingsPanel
        return (
          <Card key={entry.name} variant="outlined">
            <CardContent>
              <Stack spacing={1.25}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Typography level="title-sm">{getPluginDisplayName(entry.name)}</Typography>
                  {entry.api && entry.web && <Chip size="sm" variant="soft">api+web</Chip>}
                </Stack>
                {entry.description ? (
                  <Typography level="body-xs" textColor="text.tertiary">
                    {entry.description}
                  </Typography>
                ) : null}
                {Panel ? (
                  <Panel />
                ) : (
                  <Typography level="body-sm" textColor="text.tertiary">
                    This notification channel has no configurable settings.
                  </Typography>
                )}
              </Stack>
            </CardContent>
          </Card>
        )
      })}
    </Stack>
  )
}