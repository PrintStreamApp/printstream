/** Visible sync preview inside the manager, using the same counts as its compact badge. */
import { Alert } from '@mui/joy'
import CloudSyncRoundedIcon from '@mui/icons-material/CloudSyncRounded'
import { extractErrorMessage, type BambuCloudSyncCheckResponse } from '@printstream/shared'
import { describeOutstanding, describeOutstandingLabel } from './syncStatusText'

interface SyncNoticeProps {
  check: BambuCloudSyncCheckResponse | undefined
  checking: boolean
  syncing: boolean
  error: unknown
}

/** Distinguish an unknown preview, pending work, and a verified empty preview. */
function describeSyncNotice({ check, checking, syncing, error }: SyncNoticeProps): string {
  if (syncing) return 'Syncing presets with Bambu Cloud…'
  if (checking) return 'Checking for preset updates…'
  if (error) return `Could not check preset updates: ${extractErrorMessage(error)}`
  if (!check?.connected) return 'Preset update status is not available yet.'

  const importable = check.pullable ?? 0
  const uploadable = check.pushable ?? 0
  const pending = check.pending ?? 0
  if (importable + uploadable > 0) {
    return `${describeOutstandingLabel(importable, uploadable)}. ${describeOutstanding(importable, uploadable, pending, check.checkedAt)}`
  }
  if (pending > 0) return describeOutstanding(0, 0, pending, check.checkedAt)
  const held = check.held ?? 0
  if (held > 0) return `${held} preset${held === 1 ? ' is' : 's are'} on hold after a sync rejection.`
  return 'Presets are up to date.'
}

/** Keep loading and check failures visible instead of claiming there is nothing to sync. */
export function BambuCloudSyncNotice(props: SyncNoticeProps): JSX.Element {
  let color: 'primary' | 'warning' | 'neutral' = 'neutral'
  if (props.error || (props.check?.pending ?? 0) > 0 || (props.check?.held ?? 0) > 0) color = 'warning'
  else if ((props.check?.pullable ?? 0) + (props.check?.pushable ?? 0) > 0) color = 'primary'

  return (
    <Alert color={color} variant="soft" startDecorator={<CloudSyncRoundedIcon />}>
      {describeSyncNotice(props)}
    </Alert>
  )
}
