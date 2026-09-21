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
import { Badge, CircularProgress, Dropdown, IconButton, ListItemDecorator, Menu, MenuButton, MenuItem, Tooltip } from '@mui/joy'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import CloudSyncRoundedIcon from '@mui/icons-material/CloudSyncRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage } from '@printstream/shared'
import { useLocation, useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'
import { formatDateTime } from '../../lib/time'
import { buildWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'
import { BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH } from './settings-route'

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
  const location = useLocation()
  const navigate = useNavigate()
  const workspaceSlug = parseWorkspacePathname(location.pathname).workspaceSlug
  const accountSettingsPath = workspaceSlug
    ? buildWorkspacePath(workspaceSlug, BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH)
    : null

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
      <StatusControl
        tone="warning"
        count={importable + uploadable + pending}
        tooltip="Bambu Lab sign-in expired. Reconnect in Bambu account settings."
      >
        <MenuItem disabled={!accountSettingsPath} onClick={() => accountSettingsPath && navigate(accountSettingsPath)}>
          Reconnect Bambu account
        </MenuItem>
      </StatusControl>
    )
  }

  // Deletions are deliberately NOT actionable from here: each one is a per-preset
  // confirmation with real consequences on every device the account touches, and a slice
  // sidebar is the wrong place to be answering that. Point at the manager instead.
  if (pending > 0 && importable + uploadable === 0) {
    return (
      <StatusControl
        tone="warning"
        count={pending}
        tooltip={`${pending} deleted preset${pending === 1 ? '' : 's'} to review in Bambu account settings.`}
      >
        <MenuItem disabled={!accountSettingsPath} onClick={() => accountSettingsPath && navigate(accountSettingsPath)}>
          Review Bambu account sync
        </MenuItem>
      </StatusControl>
    )
  }

  return (
    <StatusControl
      tone="primary"
      count={importable + uploadable}
      busy={syncMutation.isPending}
      tooltip={`${describeOutstandingLabel(importable, uploadable)}. ${describeOutstanding(importable, uploadable, pending, check.checkedAt)}`}
      onDismiss={() => setDismissed(true)}
    >
      {/* Disabled while in flight rather than disabling the trigger: this is the action that must
          not run twice, and the trigger is also the only way to reach Hide. */}
      <MenuItem disabled={syncMutation.isPending} onClick={() => syncMutation.mutate()}>
        <ListItemDecorator><CloudSyncRoundedIcon /></ListItemDecorator>
        {syncMutation.isPending ? 'Syncing…' : `Sync ${describeOutstandingLabel(importable, uploadable)}`}
      </MenuItem>
    </StatusControl>
  )
}

/**
 * One compact control, sitting beside `Manage presets` in the Slicer header.
 *
 * It USED to be a full-width row of its own, and before that a labelled row next to `Manage` that
 * wrapped its buttons onto two lines, clipped `Manage`, and gave the whole panel a horizontal
 * scrollbar at sidebar width. That failure was about the SHAPE, not the position: an icon carrying
 * its count as a badge costs ~32px where the row cost the full width, so it sits next to the button
 * it belongs with (both are about presets, and the manager it opens covers all three preset kinds)
 * without competing for room. The header is a single uniform-height row that cannot wrap (see
 * StickySectionHeader), which is exactly why the control has to be this small.
 *
 * Everything the row said is still reachable: the count is the badge, the detail is the tooltip,
 * and the actions moved into the menu rather than being dropped.
 */
function StatusControl({ tone, count, tooltip, busy, onDismiss, children }: {
  tone: 'primary' | 'warning'
  count: number
  tooltip: string
  /** A sync is in flight: the TRIGGER has to say so, because the menu it was started from is gone. */
  busy?: boolean
  onDismiss?: () => void
  children?: ReactNode
}): JSX.Element {
  // Choosing a menu item closes the menu, so a "Syncing…" label in there is invisible the instant
  // it becomes true. A cloud sync is not instant and only reports at the END (a toast), so without
  // this the control sat unchanged and the work looked like it had not started. The spinner
  // replaces the icon in place, keeping the badge and the row height.
  const label = busy ? 'Syncing presets with Bambu Cloud…' : tooltip
  return (
    // Dropdown gives the clickaway, Escape and keyboard nav a bare anchored Menu has none of.
    // The Tooltip goes INSIDE it, on the button: Dropdown is a context provider rather than a
    // DOM component, so wrapping it hands the tooltip's ref and aria-label to something that
    // can hold neither ("Function components cannot be given refs", and every DOM prop listed
    // as unsupported). The trigger is where the label belongs anyway.
    <Dropdown>
      <Badge badgeContent={count} size="sm" color={tone} max={99}>
        <Tooltip title={label}>
          <MenuButton
            // NOT disabled while busy. It is the only route into the menu, so disabling it took
            // "Hide until next time" away exactly when a sync had stalled and the user most wanted
            // it, with no timeout to recover. A disabled button also swallows the pointer events
            // Joy's Tooltip listens on, so the "Syncing…" label could never appear either. The
            // Sync ITEM is disabled instead, which is the action that must not run twice.
            slots={{ root: IconButton }}
            slotProps={{ root: { size: 'sm', variant: 'plain', color: tone, 'aria-label': label } }}
          >
            {busy ? <CircularProgress size="sm" color={tone} /> : <CloudSyncRoundedIcon />}
          </MenuButton>
        </Tooltip>
      </Badge>
      <Menu placement="bottom-end" sx={{ zIndex: (theme) => theme.zIndex.tooltip, maxWidth: 'calc(100vw - 32px)' }}>
        {children}
        {onDismiss ? (
          <MenuItem onClick={onDismiss}>
            <ListItemDecorator><CloseRoundedIcon /></ListItemDecorator>
            Hide until next time
          </MenuItem>
        ) : null}
      </Menu>
    </Dropdown>
  )
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
