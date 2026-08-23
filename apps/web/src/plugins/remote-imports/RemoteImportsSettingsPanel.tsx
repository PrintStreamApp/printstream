/**
 * Plugin Manager panel for remote imports.
 *
 * Holds the MakerWorld opt-in, plus a note about what is not importable yet.
 *
 * Says nothing about the companion browser helper: it is unadvertised until it is on
 * the Chrome Web Store, so no surface offers a download or install steps (see
 * `browserAssistState.ts`).
 *
 * The opt-in is its own switch rather than something implied by having a Bambu Lab
 * account connected: that account is connected for preset sync, and using the same
 * credential to fetch models is a separate decision, one that also affects other
 * members, since a workspace shares one connection. The copy therefore names the
 * account rather than just saying "connected".
 *
 * Rendered by `PluginManagerSection` through the `settingsPanel` extension point;
 * core knows nothing about this plugin by name.
 */
import Alert from '@mui/joy/Alert'
import Stack from '@mui/joy/Stack'
import Switch from '@mui/joy/Switch'
import Typography from '@mui/joy/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RemoteImportCapabilitiesResponse, RemoteImportMakerWorldCapability } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { extractErrorMessage } from '@printstream/shared'
import { toast } from '../../lib/toast'

export function RemoteImportsSettingsPanel() {
  const queryClient = useQueryClient()
  const capabilitiesQuery = useQuery({
    queryKey: ['remote-import-capabilities'],
    queryFn: ({ signal }) => apiFetch<RemoteImportCapabilitiesResponse>('/api/plugins/remote-imports/capabilities', { signal })
  })
  const makerWorld = capabilitiesQuery.data?.makerWorld

  const setEnabled = useMutation({
    mutationFn: async (enabled: boolean) => await apiFetch<RemoteImportMakerWorldCapability>(
      '/api/plugins/remote-imports/makerworld-settings',
      { method: 'PUT', body: { enabled } }
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['remote-import-capabilities'] })
    },
    onError: (error: unknown) => {
      toast.error(extractErrorMessage(error, 'Could not update MakerWorld imports.'))
    }
  })

  return (
    <Stack spacing={1.5}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
            <Typography level="title-sm">Import MakerWorld models</Typography>
            <Typography level="body-sm">
              Paste a MakerWorld model link and PrintStream downloads it using this workspace's
              connected Bambu Lab account. Turn this off if you would
              rather the workspace's downloads were not made with that account.
            </Typography>
          </Stack>
          <Switch
            // Default ON (absent means enabled), so an unloaded state must not paint an
            // unchecked switch, that reads as "someone turned this off".
            checked={makerWorld?.enabled ?? true}
            disabled={capabilitiesQuery.isPending || setEnabled.isPending}
            onChange={(event) => setEnabled.mutate(event.target.checked)}
          />
        </Stack>

        {makerWorld?.enabled && !makerWorld.accountConnected && (
          <Alert size="sm" variant="soft" color="warning">
            <Typography level="body-sm">
              No Bambu Lab account is connected for this workspace yet. Connect one in the Bambu
              Cloud plugin settings before importing.
            </Typography>
          </Alert>
        )}

        {makerWorld?.enabled && makerWorld.accountConnected && (
          <Alert size="sm" variant="soft" color="neutral">
            <Typography level="body-sm">
              Downloads run as {makerWorld.accountLabel ?? 'the connected account'} for everyone in
              this workspace.
            </Typography>
          </Alert>
        )}
      </Stack>

      <Typography level="body-sm" textColor="text.tertiary">
        Printables pages cannot be imported yet: they publish no link PrintStream can fetch on
        its own. Download the file in your browser and upload it to the library instead.
      </Typography>
    </Stack>
  )
}
