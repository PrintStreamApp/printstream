/**
 * Shared recipients-list settings panel for webhook/topic notification
 * channels (Discord, ntfy). Pairs with the API's shared recipient routes
 * (`GET /`, `POST /recipients`, `DELETE /recipients/:id` under
 * `/api/plugins/<name>`).
 *
 * Each entry is either a shared destination (receives this workspace's
 * broadcast notifications) or a personal one (receives only YOUR targeted
 * notifications — support replies, suggestion activity). Destination URLs
 * are secrets: the server never echoes them, so the list shows labels only.
 * Lives under the plugin host so importing it does not violate the
 * "plugins don't import each other" rule.
 */
import { useState } from 'react'
import {
  Button,
  Chip,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  List,
  ListItem,
  ListItemContent,
  Option,
  Select,
  Stack,
  Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded'
import PersonRoundedIcon from '@mui/icons-material/PersonRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'

interface RecipientView {
  id: string
  label: string
  audience: 'everyone' | 'personal'
  userName?: string
}

interface RecipientsResponse {
  configured: boolean
  recipients: RecipientView[]
}

interface WebhookRecipientsPanelProps {
  /** Plugin name segment in `/api/plugins/<name>`. */
  pluginName: string
  /** Input label for the destination URL ("Discord webhook URL"). */
  urlLabel: string
  placeholder: string
  /** One-line intro shown above the list. */
  description: string
}

export function WebhookRecipientsPanel(props: WebhookRecipientsPanelProps) {
  const { pluginName, urlLabel, placeholder, description } = props
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [audience, setAudience] = useState<'everyone' | 'mine'>('everyone')
  const [error, setError] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['plugin-settings', pluginName],
    queryFn: ({ signal }) => apiFetch<RecipientsResponse>(`/api/plugins/${pluginName}`, { signal })
  })

  const applyResponse = (data: RecipientsResponse) => {
    queryClient.setQueryData(['plugin-settings', pluginName], data)
  }

  const add = useMutation({
    mutationFn: () =>
      apiFetch<RecipientsResponse>(`/api/plugins/${pluginName}/recipients`, {
        method: 'POST',
        body: { url: url.trim(), label: label.trim() || undefined, audience }
      }),
    onSuccess: (data) => {
      applyResponse(data)
      setUrl('')
      setLabel('')
      setError(null)
    },
    onError: (caught: Error) => setError(caught.message)
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<RecipientsResponse>(`/api/plugins/${pluginName}/recipients/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      }),
    onSuccess: applyResponse,
    onError: (caught: Error) => setError(caught.message)
  })

  const recipients = query.data?.recipients ?? []

  return (
    <Stack spacing={1.5}>
      <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
      {query.error && <Typography color="danger" level="body-sm">{(query.error as Error).message}</Typography>}

      {recipients.length > 0 && (
        <List size="sm" variant="outlined" sx={{ borderRadius: 'sm' }}>
          {recipients.map((recipient) => (
            <ListItem
              key={recipient.id}
              endAction={
                <IconButton
                  size="sm"
                  variant="plain"
                  color="danger"
                  aria-label={`Remove ${recipient.label}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(recipient.id)}
                >
                  <DeleteOutlineRoundedIcon />
                </IconButton>
              }
            >
              <ListItemContent>
                <Stack direction="row" spacing={1} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
                  <Typography level="body-sm">{recipient.label}</Typography>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={recipient.audience === 'personal' ? 'primary' : 'neutral'}
                    startDecorator={recipient.audience === 'personal' ? <PersonRoundedIcon /> : <GroupsRoundedIcon />}
                  >
                    {recipient.audience === 'personal'
                      ? `Personal${recipient.userName ? ` · ${recipient.userName}` : ''}`
                      : 'Everyone'}
                  </Chip>
                </Stack>
              </ListItemContent>
            </ListItem>
          ))}
        </List>
      )}

      <FormControl>
        <FormLabel>{urlLabel}</FormLabel>
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={placeholder}
          disabled={add.isPending}
        />
      </FormControl>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap>
        <FormControl sx={{ flex: 1, minWidth: 160 }}>
          <FormLabel>Label</FormLabel>
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Team channel"
            disabled={add.isPending}
          />
        </FormControl>
        <FormControl sx={{ flex: 1, minWidth: 200 }}>
          <FormLabel>Delivers</FormLabel>
          <Select value={audience} onChange={(_event, next) => { if (next) setAudience(next) }} disabled={add.isPending}>
            <Option value="everyone">Workspace notifications</Option>
            <Option value="mine">Only my personal notifications</Option>
          </Select>
          <FormHelperText>
            {audience === 'mine'
              ? 'Support replies and suggestion activity addressed to you.'
              : 'Print events and other notifications for this workspace.'}
          </FormHelperText>
        </FormControl>
      </Stack>
      {error && <Typography color="danger" level="body-sm">{error}</Typography>}
      <Stack direction="row" spacing={1}>
        <Button
          size="sm"
          loading={add.isPending}
          startDecorator={<AddRoundedIcon />}
          disabled={url.trim().length === 0}
          onClick={() => add.mutate()}
        >
          Add destination
        </Button>
      </Stack>
    </Stack>
  )
}
