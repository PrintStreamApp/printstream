/**
 * Shared webhook-URL settings panel used by built-in notification
 * plugins. Each plugin only differs in label, placeholder, and the
 * API endpoint that persists the value, so we centralise the
 * fetch/save UX here. Lives under the plugin host (not a specific
 * plugin) so importing it does not violate the "plugins don't import
 * each other" rule.
 */
import { useState } from 'react'
import { Button, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import ClearRoundedIcon from '@mui/icons-material/ClearRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'

interface WebhookPanelProps {
  /** Plugin name segment in `/api/plugins/<name>`. */
  pluginName: string
  /** Endpoint suffix (e.g. `topic`, `webhook`). PUT receives `{ [bodyField]: value }`. */
  endpoint: string
  /** Body field name expected by the PUT endpoint. */
  bodyField: string
  /** Response field on both GET and PUT that signals "configured". */
  configuredField: string
  label: string
  placeholder: string
  helpConfigured: string
  helpEmpty: string
}

/**
 * Generic "paste URL, save it server-side" panel. The configured value
 * is treated as a secret and never echoed back from the API; the panel
 * only knows whether *some* value is configured.
 */
export function WebhookSettingsPanel(props: WebhookPanelProps) {
  const { pluginName, endpoint, bodyField, configuredField, label, placeholder, helpConfigured, helpEmpty } = props
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['plugin-settings', pluginName],
    queryFn: () => apiFetch<Record<string, unknown>>(`/api/plugins/${pluginName}`)
  })

  const save = useMutation({
    mutationFn: (next: string) =>
      apiFetch<Record<string, unknown>>(`/api/plugins/${pluginName}/${endpoint}`, {
        method: 'PUT',
        body: { [bodyField]: next }
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['plugin-settings', pluginName], data)
      setValue('')
      setError(null)
    },
    onError: (caught: Error) => {
      setError(caught.message)
    }
  })

  const configured = Boolean(query.data?.[configuredField])
  const saving = save.isPending

  return (
    <Stack spacing={1}>
      <Typography level="body-sm" textColor="text.tertiary">
        {configured ? helpConfigured : helpEmpty}
      </Typography>
      {query.error && <Typography color="danger" level="body-sm">{(query.error as Error).message}</Typography>}
      <FormControl>
        <FormLabel>{label}</FormLabel>
        <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} disabled={saving} />
      </FormControl>
      {error && <Typography color="danger" level="body-sm">{error}</Typography>}
      <Stack direction="row" spacing={1}>
        <Button size="sm" loading={saving} startDecorator={<SaveRoundedIcon />} onClick={() => save.mutate(value)}>Save</Button>
        <Button size="sm" variant="plain" startDecorator={<ClearRoundedIcon />} disabled={saving} onClick={() => save.mutate('')}>Clear</Button>
      </Stack>
    </Stack>
  )
}
