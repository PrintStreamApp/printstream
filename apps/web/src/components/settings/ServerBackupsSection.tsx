import React from 'react'
import BackupRoundedIcon from '@mui/icons-material/BackupRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import RestoreRoundedIcon from '@mui/icons-material/RestoreRounded'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import { Alert, Box, Button, Card, CardContent, Chip, IconButton, Sheet, Stack, Table, Tooltip, Typography } from '@mui/joy'
import {
  formatBytes,
  extractErrorMessage,
  type ServerBackupListResponse,
  type ServerBackupRestoreResponse,
  type ServerBackupRunResponse,
  type ServerBackupSnapshot
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PageSectionHeading } from '../dashboard/PageSectionHeading'
import { apiFetch } from '../../lib/apiClient'
import { formatDateTime } from '../../lib/time'
import { usePromptDialog } from '../PromptDialogProvider'

/**
 * Server backups (issue #78): status of the install's scheduled whole-install
 * backups (database dump + persistent data tree), a manual "Back up now", and
 * per-backup restore/delete. Hosted by the workspace Settings on self-hosted
 * installs and by Platform settings on cloud — same endpoints, whose authority
 * differs per deployment (see the route header). Restore is staged: the API
 * takes a safety backup, then restarts to apply the chosen backup before the
 * app reopens the database — so a successful restore looks like a short
 * outage. API counterpart: `apps/api/src/routes/server-backups.ts`.
 */
export function ServerBackupsSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()
  const { confirm, promptText } = usePromptDialog()
  const [restoreStaged, setRestoreStaged] = React.useState<string | null>(null)
  const backupsQuery = useQuery({
    queryKey: ['server-backups'],
    queryFn: ({ signal }) => apiFetch<ServerBackupListResponse>('/api/server-backups', { signal }),
    // A dump can run for minutes and completion has no WS event; poll only
    // while a run or a staged restore is actually in flight.
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status?.running || status?.restorePending ? 5_000 : false
    }
  })
  const status = backupsQuery.data?.status ?? null
  const snapshots = backupsQuery.data?.snapshots ?? []
  const runBackup = useMutation({
    mutationFn: () => apiFetch<ServerBackupRunResponse>('/api/server-backups/run', { method: 'POST' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['server-backups'] })
    }
  })
  const deleteBackup = useMutation({
    mutationFn: (name: string) => apiFetch<void>(`/api/server-backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['server-backups'] })
    }
  })
  const restoreBackup = useMutation({
    mutationFn: (name: string) => apiFetch<ServerBackupRestoreResponse>(
      `/api/server-backups/${encodeURIComponent(name)}/restore`,
      { method: 'POST' }
    ),
    onSuccess: async (result) => {
      setRestoreStaged(result.message)
      await queryClient.invalidateQueries({ queryKey: ['server-backups'] })
    }
  })

  async function confirmRestore(snapshot: ServerBackupSnapshot) {
    const typed = await promptText({
      title: `Restore the backup from ${formatDateTime(snapshot.createdAt)}?`,
      description:
        'Restoring replaces EVERYTHING on this install — every workspace, printer, job, user, and library file — '
        + 'with the state in this backup. A safety backup of the current state is taken first, then the app '
        + 'restarts to apply the restore, which looks like a short outage.',
      label: 'Type restore to confirm',
      confirmLabel: 'Restore backup',
      color: 'danger',
      validateValue: (value) => (value.trim().toLowerCase() === 'restore' ? null : 'Type the word restore to confirm.')
    })
    if (typed !== null) restoreBackup.mutate(snapshot.name)
  }

  async function confirmDelete(snapshot: ServerBackupSnapshot) {
    const confirmed = await confirm({
      title: `Delete the backup from ${formatDateTime(snapshot.createdAt)}?`,
      description: 'This backup is removed from disk permanently.',
      confirmLabel: 'Delete backup',
      color: 'danger'
    })
    if (confirmed) deleteBackup.mutate(snapshot.name)
  }

  const loadError = backupsQuery.error ? extractErrorMessage(backupsQuery.error) : null
  const actionError = runBackup.error
    ? extractErrorMessage(runBackup.error)
    : deleteBackup.error
      ? extractErrorMessage(deleteBackup.error)
      : restoreBackup.error
        ? extractErrorMessage(restoreBackup.error)
        : null
  const intervalLabel = status == null
    ? null
    : status.intervalHours <= 0
      ? 'Manual backups only'
      : status.intervalHours === 24
        ? 'Automatic, daily'
        : `Automatic, every ${status.intervalHours} hours`

  return (
    <Stack spacing={1.25}>
      <PageSectionHeading
        icon={<BackupRoundedIcon />}
        title="Backups"
        description="Automatic backups of everything on this install — the database and all stored files — kept on this machine's disk with smart retention."
        count={snapshots.length}
        actions={(
          <Button
            size="sm"
            startDecorator={<BackupRoundedIcon />}
            loading={runBackup.isPending || status?.running === true}
            disabled={!canManage || status == null || !status.available || status.restorePending}
            onClick={() => {
              runBackup.reset()
              runBackup.mutate()
            }}
          >
            Back up now
          </Button>
        )}
      />

      {loadError && <Alert color="danger">{loadError}</Alert>}
      {status && !status.available && (
        <Alert color="warning" variant="soft" startDecorator={<WarningRoundedIcon />}>
          {status.unavailableReason}
        </Alert>
      )}
      {(restoreStaged || status?.restorePending) && (
        <Alert color="primary" variant="soft">
          {restoreStaged ?? 'A restore is staged; the app is restarting to apply it. This page will reconnect when it is back.'}
        </Alert>
      )}
      {status?.lastError && <Alert color="warning">{status.lastError}</Alert>}
      {actionError && <Alert color="danger">{actionError}</Alert>}

      {status && (
        <Card variant="outlined">
          <CardContent>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(3, 1fr)' }, columnGap: 2, rowGap: 1 }}>
              <BackupDetail label="Schedule" value={intervalLabel ?? 'Unknown'} />
              <BackupDetail
                label="Last backup"
                value={status.running ? 'Backing up now…' : status.lastBackupAt ? formatDateTime(status.lastBackupAt) : 'Never'}
              />
              {status.intervalHours > 0 && (
                <BackupDetail label="Next backup" value={status.nextDueAt ? formatDateTime(status.nextDueAt) : 'Unknown'} />
              )}
              <BackupDetail label="Backups kept" value={`${status.snapshotCount} (${formatBytes(status.totalBytes)})`} />
              {status.freeBytes != null && <BackupDetail label="Free space" value={formatBytes(status.freeBytes)} />}
              <BackupDetail label="Folder" value={status.directory ?? 'Unknown'} />
            </Box>
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
              Retention keeps every backup for a week, then one per week for a month, then one per month for a year.
              Manual backups are kept until you delete them. Backups on the same disk do not protect against disk
              failure, so copy this folder off this machine with any sync tool.
            </Typography>
          </CardContent>
        </Card>
      )}

      {!loadError && snapshots.length === 0 ? (
        <Alert color="neutral">
          {backupsQuery.isLoading
            ? 'Loading backups…'
            : status?.available
              ? 'No backups yet. The first scheduled backup runs shortly, or use “Back up now”.'
              : 'No backups yet.'}
        </Alert>
      ) : snapshots.length > 0 && (
        <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
          <Table size="sm" borderAxis="xBetween" hoverRow>
            <thead>
              <tr>
                <th>Taken</th>
                <th style={{ width: 110 }}>Type</th>
                <th style={{ width: 110 }}>Size</th>
                <th style={{ width: 96 }}>App build</th>
                <th style={{ width: 170 }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <BackupRow
                  key={snapshot.name}
                  snapshot={snapshot}
                  canManage={canManage}
                  busy={restoreBackup.isPending || deleteBackup.isPending || status?.restorePending === true}
                  onRestore={() => void confirmRestore(snapshot)}
                  onDelete={() => void confirmDelete(snapshot)}
                />
              ))}
            </tbody>
          </Table>
        </Sheet>
      )}
    </Stack>
  )
}

function BackupDetail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography level="body-xs" textColor="text.tertiary">{label}</Typography>
      <Typography level="body-sm" sx={{ wordBreak: 'break-word' }}>{value}</Typography>
    </Box>
  )
}

function backupTriggerChip(trigger: ServerBackupSnapshot['trigger']): { label: string; color: 'neutral' | 'primary' | 'warning' } {
  if (trigger === 'manual') return { label: 'Manual', color: 'primary' }
  if (trigger === 'pre-restore') return { label: 'Pre-restore', color: 'warning' }
  return { label: 'Scheduled', color: 'neutral' }
}

function BackupRow({
  snapshot,
  canManage,
  busy,
  onRestore,
  onDelete
}: {
  snapshot: ServerBackupSnapshot
  canManage: boolean
  busy: boolean
  onRestore: () => void
  onDelete: () => void
}) {
  const chip = backupTriggerChip(snapshot.trigger)
  const restoreButton = (
    <Button
      size="sm"
      variant="outlined"
      color="neutral"
      startDecorator={<RestoreRoundedIcon />}
      disabled={!canManage || busy || snapshot.restoreBlockedReason != null}
      onClick={onRestore}
    >
      Restore
    </Button>
  )
  return (
    <tr>
      <th scope="row">{formatDateTime(snapshot.createdAt)}</th>
      <td><Chip size="sm" variant="soft" color={chip.color}>{chip.label}</Chip></td>
      <td>{formatBytes(snapshot.dbDumpBytes + snapshot.dataTotalBytes)}</td>
      <td>{snapshot.appRevision ? snapshot.appRevision.slice(0, 8) : 'Unknown'}</td>
      <td>
        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
          {snapshot.restoreBlockedReason ? (
            <Tooltip title={snapshot.restoreBlockedReason} placement="top">
              <span>{restoreButton}</span>
            </Tooltip>
          ) : restoreButton}
          <IconButton
            size="sm"
            variant="plain"
            color="danger"
            aria-label={`Delete the backup from ${formatDateTime(snapshot.createdAt)}`}
            disabled={!canManage || busy}
            onClick={onDelete}
          >
            <DeleteRoundedIcon />
          </IconButton>
        </Stack>
      </td>
    </tr>
  )
}
