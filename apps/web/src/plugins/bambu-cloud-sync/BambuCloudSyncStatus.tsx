/**
 * The "something to sync" notice shown on surfaces that USE presets, the 3D editor's
 * slice sidebar and the prepare-print dialog, via the `slicing.presets.syncStatus` slot.
 *
 * Exists because BambuStudio syncs on every launch and PrintStream deliberately does not:
 * presets are curated, so rewriting them on a schedule is not a call to make on someone's
 * behalf. The compromise is that opening a preset surface ASKS whether anything is
 * outstanding and says so here, at the moment someone is actually choosing a preset,
 * rather than only in Settings where they would have to think to look.
 *
 * **This mount IS the trigger.** Nothing polls Bambu on a timer, so if this component
 * does not ask, the question is never asked at all. It calls `/check`, which is cheap on
 * both sides: one listing read at most, and the API serves a cached answer for ten
 * minutes, so opening the editor twenty times in that window is one Bambu call rather
 * than twenty. (An earlier revision read `/status` instead, which only replays a stored
 * result, with no background pass left to produce one, this could never appear.)
 *
 * Renders nothing at all unless there is something to say: no account connected, or
 * nothing outstanding, means nothing rendered. A sidebar that always carries a badge stops
 * being read.
 *
 * Counterpart: `apps/api/src/plugins/bambu-cloud-sync/index.ts` (`/check`, `/sync`).
 */
import { useState, type ReactNode } from 'react'
import { Box, Button, IconButton, Sheet, Stack, Tooltip, Typography } from '@mui/joy'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import CloudSyncRoundedIcon from '@mui/icons-material/CloudSyncRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'
import { formatDateTime } from '../../lib/time'

interface CheckResponse {
  connected: boolean
  status?: 'connected' | 'expired'
  /** True when the API replayed a recent answer instead of calling Bambu. */
  cached?: boolean
  checkedAt?: string
  pullable?: number
  pushable?: number
  pending?: number
}

const CHECK_QUERY_KEY = ['bambu-cloud-sync', 'check']

export function BambuCloudSyncStatus(): JSX.Element | null {
  const queryClient = useQueryClient()
  const [dismissed, setDismissed] = useState(false)

  const checkQuery = useQuery({
    queryKey: CHECK_QUERY_KEY,
    queryFn: ({ signal }) => apiFetch<CheckResponse>('/api/plugins/bambu-cloud-sync/check', { method: 'POST', signal }),
    // Two layers of restraint on top of each other: this keeps a mount from re-asking the
    // API, and the API keeps a re-ask from reaching Bambu. Neither alone is enough: the
    // editor and the print dialog mount this independently.
    staleTime: 5 * 60_000,
    // A workspace with no Bambu account is the common case; retrying its non-answer on
    // every editor open would be pure noise.
    retry: false
  })

  const syncMutation = useMutation({
    mutationFn: async () => await apiFetch('/api/plugins/bambu-cloud-sync/sync', { method: 'POST' }),
    onSuccess: async () => {
      // A pull writes presets, so every surface reading them is now stale.
      await queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
      await queryClient.invalidateQueries({ queryKey: CHECK_QUERY_KEY })
      toast.show({ message: 'Presets synced with Bambu Cloud.', tone: 'success' })
    },
    onError: (error) => {
      toast.show({ message: extractErrorMessage(error), tone: 'danger' })
    }
  })

  const check = checkQuery.data
  if (!check?.connected || dismissed) return null

  const importable = check.pullable ?? 0
  const uploadable = check.pushable ?? 0
  const pending = check.pending ?? 0
  if (importable + uploadable + pending === 0) return null

  // A dead credential cannot be fixed from here, so point at where it can be rather than
  // offering a Sync that is guaranteed to fail.
  if (check.status === 'expired') {
    return (
      <StatusRow tone="warning" label="Bambu Lab sign-in expired">
        <Typography level="body-xs" textColor="text.tertiary">
          Reconnect in Settings, then Slicing.
        </Typography>
      </StatusRow>
    )
  }

  // Deletions are deliberately NOT actionable from here: each one is a per-preset
  // confirmation with real consequences on every device the account touches, and a slice
  // sidebar is the wrong place to be answering that. Point at the manager instead.
  if (pending > 0 && importable + uploadable === 0) {
    return (
      <StatusRow tone="warning" label={`${pending} deleted preset${pending === 1 ? '' : 's'} to review`}>
        <Typography level="body-xs" textColor="text.tertiary">
          Decide in Settings, then Slicing.
        </Typography>
      </StatusRow>
    )
  }

  return (
    <StatusRow
      tone="primary"
      label={describeOutstandingLabel(importable, uploadable)}
      tooltip={describeOutstanding(importable, uploadable, pending, check.checkedAt)}
      onDismiss={() => setDismissed(true)}
    >
      <Button
        type="button"
        size="sm"
        variant="solid"
        loading={syncMutation.isPending}
        disabled={syncMutation.isPending}
        onClick={() => syncMutation.mutate()}
      >
        Sync
      </Button>
    </StatusRow>
  )
}

/**
 * One row: what is outstanding on the left, what you can do about it on the right.
 *
 * Full width and allowed to WRAP, because both hosts are narrow, the editor sidebar is
 * ~540px and the print-prep dialog is narrower, and this has to survive a 375px phone.
 * An earlier revision sat inside the Process header next to `Manage`, which at sidebar
 * width wrapped its own buttons onto two lines, clipped `Manage`, and gave the panel a
 * horizontal scrollbar.
 */
function StatusRow({ tone, label, tooltip, onDismiss, children }: {
  tone: 'primary' | 'warning'
  label: string
  tooltip?: string
  onDismiss?: () => void
  children?: ReactNode
}): JSX.Element {
  const row = (
    <Sheet
      variant="soft"
      color={tone}
      sx={{ px: 1, py: 0.75, borderRadius: 'sm' }}
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <CloudSyncRoundedIcon fontSize="small" />
        {/* Takes the slack so the actions sit at the far end, and shrinks before they do. */}
        <Typography level="body-sm" sx={{ flex: 1, minWidth: '8rem' }}>{label}</Typography>
        <Stack direction="row" spacing={0.5} alignItems="center">
          {children}
          {onDismiss ? (
            <Tooltip title="Hide until next time">
              <IconButton type="button" size="sm" variant="plain" color="neutral" onClick={onDismiss} aria-label="Hide">
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Stack>
      </Stack>
    </Sheet>
  )
  return tooltip ? <Tooltip title={tooltip}><Box>{row}</Box></Tooltip> : row
}

function describeOutstandingLabel(importable: number, uploadable: number): string {
  if (importable > 0 && uploadable > 0) return `${importable + uploadable} preset changes`
  if (importable > 0) return `${importable} preset update${importable === 1 ? '' : 's'}`
  return `${uploadable} preset${uploadable === 1 ? '' : 's'} to upload`
}

function describeOutstanding(importable: number, uploadable: number, pending: number, checkedAt: string | undefined): string {
  const parts: string[] = []
  if (importable > 0) parts.push(`${importable} to import from Bambu Cloud`)
  if (uploadable > 0) parts.push(`${uploadable} to upload`)
  if (pending > 0) parts.push(`${pending} deletion${pending === 1 ? '' : 's'} awaiting a decision in Settings`)
  const checked = checkedAt ? new Date(checkedAt) : null
  const when = !checked || Number.isNaN(checked.getTime()) ? '' : ` Checked ${formatDateTime(checked)}.`
  return `${parts.join(', ')}.${when}`
}
