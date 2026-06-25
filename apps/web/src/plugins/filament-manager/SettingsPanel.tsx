/**
 * Settings panel shown in the plugin manager: the single `autoAddBambuSpools`
 * toggle (default on) that controls whether inserting an RFID Bambu spool into
 * an AMS slot auto-creates a library spool.
 */
import { Box, Checkbox, Stack, Typography } from '@mui/joy'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FilamentManagerSettings } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { FILAMENT_SETTINGS_QUERY_KEY } from './api'

export function FilamentManagerSettingsPanel() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: FILAMENT_SETTINGS_QUERY_KEY,
    queryFn: () => apiFetch<FilamentManagerSettings>('/api/plugins/filament-manager/settings')
  })
  const save = useMutation({
    mutationFn: (autoAddBambuSpools: boolean) =>
      apiFetch<FilamentManagerSettings>('/api/plugins/filament-manager/settings', {
        method: 'PUT',
        body: { autoAddBambuSpools }
      }),
    onSuccess: (data) => queryClient.setQueryData(FILAMENT_SETTINGS_QUERY_KEY, data)
  })

  const autoAdd = query.data?.autoAddBambuSpools ?? true
  const saving = save.isPending

  return (
    <Stack spacing={1}>
      {query.error && <Typography color="danger" level="body-sm">{(query.error as Error).message}</Typography>}
      <Stack direction="row" spacing={1.25} alignItems="flex-start">
        <Checkbox
          checked={autoAdd}
          disabled={query.isLoading || saving}
          onChange={(event) => save.mutate(event.target.checked)}
          sx={{ mt: 0.25 }}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm">Auto-add Bambu spools</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            When an RFID-tagged Bambu spool is inserted into any AMS slot, add it to the filament library automatically.
          </Typography>
        </Box>
      </Stack>
    </Stack>
  )
}
