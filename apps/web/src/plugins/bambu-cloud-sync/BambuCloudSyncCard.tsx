/**
 * The Bambu Cloud panel inside the slicing-preset manager.
 *
 * Shows whether an account is connected, lets someone connect or disconnect one, and
 * runs a sync on demand (a background pass also runs on its own schedule). The result
 * of a manual sync is reported per preset, because "synced" alone hides the two answers
 * that matter: what it decided to leave alone, and what Bambu rejected.
 *
 * A deletion on either side never happens on its own — the sync engine freezes it and
 * reports it as a pending decision (`/status`'s `pendingDeletionConfirmations`), which
 * this card renders as its own banner with an explicit Confirm/Decline pair per preset.
 * Sourced from `/status` rather than the last sync's own result so it survives a page
 * reload and surfaces anything the BACKGROUND pass found too, not just a manual sync.
 *
 * Rendered through the `slicing.presets.sync` slot, so the manager looks exactly as it
 * did when this plugin is not installed.
 *
 * Counterpart: `apps/api/src/plugins/bambu-cloud-sync/index.ts`.
 */
import { useState } from 'react'
import { Alert, Button, Card, Chip, Divider, Stack, Typography } from '@mui/joy'
import CloudSyncRoundedIcon from '@mui/icons-material/CloudSyncRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { formatDateTime } from '../../lib/time'
import { BambuCloudConnectDialog } from './BambuCloudConnectDialog'

interface SyncOutcome {
  name: string
  kind: string
  detail?: string
}

interface SyncResult {
  pulled: SyncOutcome[]
  created: SyncOutcome[]
  updated: SyncOutcome[]
  deleted: string[]
  skipped: SyncOutcome[]
  failed: SyncOutcome[]
  missingRemotely: SyncOutcome[]
  missingLocally: SyncOutcome[]
  route: 'bridge' | 'direct'
}

interface PendingDeletionConfirmation {
  presetId: string
  name: string
  kind: string
  /** `missingRemotely`: still local, gone from Bambu Cloud. `missingLocally`: the reverse. */
  direction: 'missingRemotely' | 'missingLocally'
  detectedAt: string
}

interface StatusResponse {
  connection: {
    account: string
    region: 'global' | 'china'
    status: 'connected' | 'expired'
    lastSyncedAt?: string | null
    lastError?: string | null
    quotaBlockedKinds: string[]
  } | null
  syncedPresetCount: number
  heldPresetCount: number
  pendingDeletionConfirmations: PendingDeletionConfirmation[]
}

const STATUS_QUERY_KEY = ['bambu-cloud-sync', 'status']

export function BambuCloudSyncCard(): JSX.Element {
  const queryClient = useQueryClient()
  const [connecting, setConnecting] = useState(false)
  const [lastResult, setLastResult] = useState<SyncResult | null>(null)

  const statusQuery = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: ({ signal }) => apiFetch<StatusResponse>('/api/plugins/bambu-cloud-sync/status', { signal })
  })

  const syncMutation = useMutation({
    mutationFn: async () => await apiFetch<SyncResult>('/api/plugins/bambu-cloud-sync/sync', { method: 'POST' }),
    onSuccess: async (result) => {
      setLastResult(result)
      // The pull may have written presets, so the manager's list is now stale.
      await queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
      await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
    }
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => await apiFetch('/api/plugins/bambu-cloud-sync/disconnect', { method: 'POST' }),
    onSuccess: async () => {
      setLastResult(null)
      await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
    }
  })

  const resolveMutation = useMutation({
    mutationFn: async ({ presetId, action }: { presetId: string; action: 'confirm' | 'decline' }) =>
      await apiFetch(`/api/plugins/bambu-cloud-sync/presets/${encodeURIComponent(presetId)}/resolve-delete`, {
        method: 'POST',
        body: { action }
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
      // A `confirm` may have deleted a local preset (or, on the next sync, a cloud one);
      // the manager's list needs to catch up either way.
      await queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
    }
  })

  const connection = statusQuery.data?.connection ?? null
  const pendingDeletions = statusQuery.data?.pendingDeletionConfirmations ?? []
  const busy = syncMutation.isPending || disconnectMutation.isPending

  return (
    <Card variant="outlined">
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <CloudSyncRoundedIcon fontSize="small" />
          <Typography level="title-md">Bambu Lab account</Typography>
          {connection ? (
            <Chip size="sm" variant="soft" color={connection.status === 'expired' ? 'warning' : 'success'}>
              {connection.status === 'expired' ? 'Sign-in expired' : 'Connected'}
            </Chip>
          ) : null}
        </Stack>

        <Typography level="body-sm" textColor="text.tertiary">
          Keeps your presets and the ones in Bambu Studio in step, both ways. Whichever copy was
          edited most recently wins. This does not connect your printers to Bambu&apos;s cloud — only
          your account&apos;s preset library is read and written.
        </Typography>

        {connection ? (
          <>
            <Divider />
            <Stack spacing={0.5}>
              <Typography level="body-sm">
                Connected as <strong>{connection.account}</strong>
                {connection.region === 'china' ? ' (China)' : ''}
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary">
                {statusQuery.data?.syncedPresetCount ?? 0} preset{(statusQuery.data?.syncedPresetCount ?? 0) === 1 ? '' : 's'} linked
                {connection.lastSyncedAt
                  ? ` · last synced ${formatDateTime(connection.lastSyncedAt)}`
                  : ' · not synced yet'}
              </Typography>
            </Stack>

            {connection.status === 'expired' ? (
              <Alert color="warning" variant="soft">
                Bambu Lab no longer accepts the stored sign-in. Reconnect the account to keep syncing.
              </Alert>
            ) : null}

            {connection.quotaBlockedKinds.length > 0 ? (
              <Alert color="warning" variant="soft">
                This Bambu Lab account has reached its limit for stored presets, so new ones are not
                being uploaded. Remove some in Bambu Studio, or keep the extras in PrintStream only.
              </Alert>
            ) : null}

            {pendingDeletions.length > 0 ? (
              <Stack spacing={0.75}>
                {pendingDeletions.map((entry) => (
                  <PendingDeletionAlert
                    key={entry.presetId}
                    entry={entry}
                    onResolve={(action) => resolveMutation.mutate({ presetId: entry.presetId, action })}
                    pending={resolveMutation.isPending && resolveMutation.variables?.presetId === entry.presetId}
                    disabled={resolveMutation.isPending}
                  />
                ))}
              </Stack>
            ) : null}

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button
                size="sm"
                loading={syncMutation.isPending}
                disabled={busy || connection.status === 'expired'}
                onClick={() => syncMutation.mutate()}
              >
                Sync now
              </Button>
              <Button size="sm" variant="outlined" onClick={() => setConnecting(true)} disabled={busy}>
                Reconnect
              </Button>
              <Button
                size="sm"
                variant="outlined"
                color="danger"
                loading={disconnectMutation.isPending}
                disabled={busy}
                onClick={() => disconnectMutation.mutate()}
              >
                Disconnect
              </Button>
            </Stack>
          </>
        ) : (
          <Stack direction="row" spacing={1}>
            <Button size="sm" onClick={() => setConnecting(true)}>Connect account</Button>
          </Stack>
        )}

        {syncMutation.error ? (
          <Alert color="danger" variant="soft">{extractErrorMessage(syncMutation.error)}</Alert>
        ) : null}
        {resolveMutation.error ? (
          <Alert color="danger" variant="soft">{extractErrorMessage(resolveMutation.error)}</Alert>
        ) : null}

        {lastResult ? <SyncResultSummary result={lastResult} /> : null}
      </Stack>

      {connecting ? (
        <BambuCloudConnectDialog
          onClose={() => setConnecting(false)}
          onConnected={async () => {
            setConnecting(false)
            await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
          }}
        />
      ) : null}
    </Card>
  )
}

/**
 * What the last sync did.
 *
 * Skipped and failed presets are listed by name with their reason rather than counted:
 * a preset that quietly stopped syncing is the failure mode that costs people work, and
 * a number alone gives them nothing to act on. Deletions needing a decision get only a
 * count here — the persistent `pendingDeletions` banner above is where they are acted on.
 */
function SyncResultSummary({ result }: { result: SyncResult }): JSX.Element {
  const changed = result.pulled.length + result.created.length + result.updated.length + result.deleted.length
  const needsDecision = result.missingRemotely.length + result.missingLocally.length

  return (
    <Alert color={result.failed.length > 0 ? 'warning' : 'neutral'} variant="soft">
      <Stack spacing={0.75}>
        <Typography level="body-sm">
          {changed === 0
            ? 'Everything was already up to date.'
            : `Imported ${result.pulled.length}, uploaded ${result.created.length + result.updated.length}${result.deleted.length > 0 ? `, removed ${result.deleted.length} from Bambu Cloud` : ''}.`}
          {result.route === 'bridge' ? ' Synced through your bridge.' : ''}
          {needsDecision > 0 ? ` ${needsDecision} preset${needsDecision === 1 ? '' : 's'} deleted on one side need${needsDecision === 1 ? 's' : ''} a decision below.` : ''}
        </Typography>

        {result.skipped.map((entry) => (
          <Typography key={`skipped-${entry.name}`} level="body-xs" textColor="text.tertiary">
            Skipped {entry.name}: {entry.detail}
          </Typography>
        ))}
        {result.failed.map((entry) => (
          <Typography key={`failed-${entry.name}`} level="body-xs" textColor="text.tertiary">
            Could not sync {entry.name}: {entry.detail}
          </Typography>
        ))}
      </Stack>
    </Alert>
  )
}

/**
 * One deletion awaiting a decision. `missingRemotely` (gone from Bambu Cloud, still
 * here) and `missingLocally` (the reverse) get mirrored copy and button labels so the
 * warning always names the side that is about to change, not the side that already did.
 */
function PendingDeletionAlert({ entry, onResolve, pending, disabled }: {
  entry: PendingDeletionConfirmation
  onResolve: (action: 'confirm' | 'decline') => void
  pending: boolean
  disabled: boolean
}): JSX.Element {
  const isMissingRemotely = entry.direction === 'missingRemotely'
  return (
    <Alert color="warning" variant="soft">
      <Stack spacing={0.75} sx={{ width: '100%' }}>
        <Typography level="body-sm">
          <strong>{entry.name}</strong> was deleted {isMissingRemotely ? 'in Bambu Cloud' : 'here'}
          {entry.detectedAt ? ` · noticed ${formatDateTime(entry.detectedAt)}` : ''}.
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            size="sm"
            color="danger"
            variant="outlined"
            loading={pending}
            disabled={disabled}
            onClick={() => onResolve('confirm')}
          >
            {isMissingRemotely ? 'Delete here too' : 'Remove from Bambu Cloud'}
          </Button>
          <Button
            size="sm"
            variant="plain"
            disabled={disabled}
            onClick={() => onResolve('decline')}
          >
            {isMissingRemotely ? 'Keep as local-only' : 'Keep in Bambu Cloud'}
          </Button>
        </Stack>
      </Stack>
    </Alert>
  )
}
