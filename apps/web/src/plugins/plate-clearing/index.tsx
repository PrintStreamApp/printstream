/**
 * Plate-clearing plugin (web side).
 *
 * Mirrors the API plugin's per-printer state and contributes a
 * `printer.card.actions` slot that:
 *
 * - Renders nothing when the plate is in the `cleared` state (the
 *   default), so the printer card looks unchanged.
 * - Renders a prominent "Mark cleared" button
 *   when a finished print has set the printer into `needs-clear`.
 * - Contributes a settings panel that controls whether confirming a
 *   cleared plate also clears the cached last job shown on printer cards.
 *
 * State syncs through the shared `wsClient` (`plugin.event` envelope)
 * and a TanStack Query cache. The button POSTs the confirm endpoint;
 * the server broadcasts the resulting state and every open client
 * updates simultaneously.
 */
/* eslint-disable react-refresh/only-export-components -- plugin entry exports a component intentionally */
import { useState } from 'react'
import { Box, Button, Checkbox, MenuItem, Stack, Tooltip, Typography } from '@mui/joy'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PRINTERS_CLEAR_PLATE_PERMISSION,
  isPrinterIdleCompatibleStage,
  type PrinterStatus
} from '@printstream/shared'
import type { WebPlugin } from '../../plugin/types'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../../lib/workspaceScope'
import {
  PLATE_CLEARING_STATE_QUERY_KEY,
  type PlateClearingStateResponse,
  mergePlateClearingState,
  usePlateClearingState,
  usePlateClearingSync
} from '../../lib/plateClearing'

function PlateClearingAction({
  printerId,
  presentation = 'inline'
}: {
  printerId: string
  presentation?: 'inline' | 'menu'
}) {
  usePlateClearingSync()
  const queryClient = useQueryClient()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const { cleared } = usePlateClearingState(printerId)
  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const [pending, setPending] = useState(false)
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const canClearPlate = authBootstrapQuery.data
    ? !authEnabled || authBootstrapQuery.data.permissions.includes(PRINTERS_CLEAR_PLATE_PERMISSION)
    : false
  const status = statusQuery.data?.[printerId]
  const canMarkCleared = status?.online && isPrinterIdleCompatibleStage(status.stage)

  const confirm = useMutation({
    mutationFn: async () => {
      setPending(true)
      try {
        await apiFetch(`/api/plugins/plate-clearing/state/${printerId}/clear`, { method: 'POST' })
      } finally {
        setPending(false)
      }
    },
    onSuccess: () => {
      queryClient.setQueryData<PlateClearingStateResponse>(
        PLATE_CLEARING_STATE_QUERY_KEY,
        (existing) => mergePlateClearingState(existing, printerId, true)
      )
    }
  })

  if (authBootstrapQuery.isLoading || !canClearPlate || cleared || !canMarkCleared) return null

  if (presentation === 'menu') {
    return <MenuItem disabled={pending} onClick={() => confirm.mutate()}>{pending ? 'Marking cleared…' : 'Mark cleared'}</MenuItem>
  }

  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center' }}>
      <Tooltip title="Confirm that the printer plate has been cleared and that a new job can be started.">
        <Button size="sm" color="warning" loading={pending} startDecorator={<CheckCircleRoundedIcon />} onClick={() => confirm.mutate()}>
          Mark cleared
        </Button>
      </Tooltip>
    </Box>
  )
}

function PlateClearingSettingsPanel() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['plugin-settings', 'plate-clearing'],
    queryFn: () => apiFetch<{ clearLastJobOnClear: boolean }>('/api/plugins/plate-clearing')
  })
  const save = useMutation({
    mutationFn: (clearLastJobOnClear: boolean) =>
      apiFetch<{ clearLastJobOnClear: boolean }>('/api/plugins/plate-clearing/settings', {
        method: 'PUT',
        body: { clearLastJobOnClear }
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['plugin-settings', 'plate-clearing'], data)
    }
  })

  const clearLastJobOnClear = query.data?.clearLastJobOnClear ?? true
  const saving = save.isPending

  return (
    <Stack spacing={1}>
      {query.error && <Typography color="danger" level="body-sm">{(query.error as Error).message}</Typography>}
      <Stack
        direction="row"
        spacing={1.25}
        alignItems="flex-start"
        onClick={() => {
          if (!saving) save.mutate(!clearLastJobOnClear)
        }}
        sx={{ cursor: saving ? 'progress' : 'pointer' }}
      >
        <Checkbox
          checked={clearLastJobOnClear}
          disabled={query.isLoading || saving}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => save.mutate(event.target.checked)}
          sx={{ mt: 0.25 }}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm">Clear last job when marking cleared</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            Remove the last completed job from the printer card when you confirm the plate has been cleared.
          </Typography>
        </Box>
      </Stack>
    </Stack>
  )
}

export const plateClearingPlugin: WebPlugin = {
  name: 'plate-clearing',
  version: '0.1.0',
  description: 'Block new prints until the build plate has been confirmed cleared.',
  settingsPanel: PlateClearingSettingsPanel,
  slots: [
    {
      name: 'printer.card.actions',
      component: ({ printerId, presentation }) => {
        if (typeof printerId !== 'string') return null
        return <PlateClearingAction printerId={printerId} presentation={presentation === 'menu' ? 'menu' : 'inline'} />
      }
    }
  ]
}
