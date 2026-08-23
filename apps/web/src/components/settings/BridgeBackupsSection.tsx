import React from 'react'
import { Alert, Box, Button, Chip, DialogTitle, Sheet, Stack, Table, Typography } from '@mui/joy'
import {
  formatBytes,
  extractErrorMessage,
  type BridgeBackupListResponse,
  type BridgeBackupStatus,
  type BridgeSummary
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'
import { invalidateBridgeQueries } from '../../lib/bridgeQueryInvalidation'
import { formatDateTime } from '../../lib/time'
import { BackAwareModal } from '../BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'

/**
 * "Backups" group of the bridge Manage dialog: live status of the bridge's
 * on-disk backups (snapshots of its identity + library written to a folder on
 * the bridge machine), a "Back up now" action, and the snapshot list dialog.
 * Status updates ride the `bridge.backup` WS event into the bridge list cache,
 * so a minutes-long backup is tracked live without polling.
 */
export function BridgeBackupsSection({ bridge, actionsDisabled }: { bridge: BridgeSummary; actionsDisabled: boolean }) {
  const queryClient = useQueryClient()
  const [listOpen, setListOpen] = React.useState(false)
  const online = bridge.connectionStats.connected
  const backup = bridge.backup
  const runBackup = useMutation({
    mutationFn: () => apiFetch<BridgeBackupStatus>(`/api/bridges/${encodeURIComponent(bridge.id)}/backups/run`, {
      method: 'POST'
    }),
    onSuccess: async () => {
      await invalidateBridgeQueries(queryClient)
    }
  })
  const runError = runBackup.error ? extractErrorMessage(runBackup.error) : null

  return (
    <Stack spacing={1}>
      <Box>
        <Typography level="title-sm">Backups</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          Snapshots of this bridge’s identity and library files, saved to a folder on the bridge machine
          so its files survive a wiped or reinstalled bridge.
        </Typography>
      </Box>
      {!online ? (
        // The API's status mirror drops on disconnect, so an offline bridge's
        // backup state is genuinely unknown: say that, not "not set up".
        <Typography level="body-xs" textColor="text.tertiary">
          Backup status is available while the bridge is online.
        </Typography>
      ) : backup.configured ? (
        <Typography level="body-xs">
          {backup.running
            ? 'Backing up now…'
            : backup.lastBackupAt
              ? `Last backup ${formatDateTime(backup.lastBackupAt)}.`
              : 'No backups yet.'}
          {' '}
          {backup.snapshotCount === 1 ? '1 backup' : `${backup.snapshotCount} backups`} in {backup.directory}
          {backup.intervalHours != null && backup.intervalHours > 0
            ? `, running every ${backup.intervalHours === 24 ? 'day' : `${backup.intervalHours} hours`}.`
            : ', run manually.'}
        </Typography>
      ) : (
        <Typography level="body-xs" textColor="text.tertiary">
          Not set up on this bridge. Point <code>BRIDGE_BACKUP_DIR</code> at a folder outside the bridge’s
          own data (the Docker setup mounts <code>./backups</code>) and restart the bridge to enable
          daily backups.
        </Typography>
      )}
      {backup.lastError && <Alert color="warning">{backup.lastError}</Alert>}
      {runError && <Alert color="danger">{runError}</Alert>}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
        <Button
          variant="outlined"
          loading={runBackup.isPending || backup.running}
          disabled={!online || !backup.configured || actionsDisabled}
          onClick={() => {
            runBackup.reset()
            runBackup.mutate()
          }}
        >
          Back up now
        </Button>
        <Button
          variant="outlined"
          color="neutral"
          disabled={!online || !backup.configured}
          onClick={() => setListOpen(true)}
        >
          View backups
        </Button>
      </Stack>
      {listOpen && <BridgeBackupsDialog bridge={bridge} onClose={() => setListOpen(false)} />}
    </Stack>
  )
}

/** Snapshot list, fetched from the bridge on open (and after each completed run). */
function BridgeBackupsDialog({ bridge, onClose }: { bridge: BridgeSummary; onClose: () => void }) {
  const backupsQuery = useQuery({
    queryKey: ['bridge-backups', bridge.id],
    queryFn: ({ signal }) => apiFetch<BridgeBackupListResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}/backups`, { signal })
  })
  const snapshots = backupsQuery.data?.snapshots ?? []
  const loadError = backupsQuery.error ? extractErrorMessage(backupsQuery.error) : null

  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 560 } }}>
        <DialogTitle>{bridge.name} backups</DialogTitle>
        <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
          <Stack spacing={1.25}>
            <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
              <Typography level="body-sm" textColor="text.tertiary">
                Each backup is a complete, restorable copy in {backupsQuery.data?.status.directory ?? 'the backup folder'} on the bridge machine.
              </Typography>
              <Button size="sm" variant="plain" loading={backupsQuery.isFetching} onClick={() => backupsQuery.refetch()}>
                Refresh
              </Button>
            </Stack>
            {loadError && <Alert color="danger">{loadError}</Alert>}
            {!loadError && snapshots.length === 0 && (
              <Alert color="neutral">
                {backupsQuery.isLoading ? 'Loading backups…' : 'No backups yet. Use “Back up now” to take the first one.'}
              </Alert>
            )}
            {snapshots.length > 0 && (
              <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
                <Table size="sm" borderAxis="xBetween" hoverRow>
                  <thead>
                    <tr>
                      <th>Taken</th>
                      <th style={{ width: 96 }}>Type</th>
                      <th style={{ width: 72 }}>Files</th>
                      <th style={{ width: 96 }}>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshots.map((snapshot) => (
                      <tr key={snapshot.name}>
                        <th scope="row">{formatDateTime(snapshot.createdAt)}</th>
                        <td>
                          <Chip size="sm" variant="soft" color={snapshot.trigger === 'manual' ? 'primary' : 'neutral'}>
                            {snapshot.trigger === 'manual' ? 'Manual' : 'Scheduled'}
                          </Chip>
                        </td>
                        <td>{snapshot.fileCount}</td>
                        <td>{formatBytes(snapshot.totalBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Sheet>
            )}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1.5 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
