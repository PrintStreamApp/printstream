/**
 * The conditional status chips that trail the printer name/model in the card header: current
 * stage, pending-dispatch state, HMS error alerts, and the LAN-mode warning. Each chip is gated
 * on live status, so the row is empty for an idle, healthy, cloud-connected printer. Extracted
 * from PrinterCard to keep the card body render-focused.
 */
import { Chip, Tooltip } from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import type { PrinterModel, PrinterStatus } from '@printstream/shared'
import { PrinterErrorChip } from './PrinterErrorChip'
import { formatStageLabel } from '../../lib/printersViewHelpers'
import { stageLabelColor } from '../printerJobProgressTone'

export interface PrinterCardStatusChipsProps {
  status: PrinterStatus | undefined
  isIdleLikeStage: boolean
  showPendingDispatchSummary: boolean
  hasActiveJob: boolean
  pendingStartWarning: boolean
  isOnline: boolean
  /** Whether the active view shows HMS health alerts (the per-card "HMS errors" toggle). */
  showHmsErrors: boolean
  printerModel: PrinterModel
  printerSerial: string
}

export function PrinterCardStatusChips({
  status,
  isIdleLikeStage,
  showPendingDispatchSummary,
  hasActiveJob,
  pendingStartWarning,
  isOnline,
  showHmsErrors,
  printerModel,
  printerSerial
}: PrinterCardStatusChipsProps) {
  return (
    <>
      {!isIdleLikeStage && (
        <Chip
          size="sm"
          variant="soft"
          color={stageLabelColor(status)}
          sx={{ flexShrink: 0 }}
        >
          {formatStageLabel(status)}
        </Chip>
      )}
      {showPendingDispatchSummary && hasActiveJob && (
        <Chip
          size="sm"
          variant="soft"
          color={pendingStartWarning ? 'warning' : 'success'}
          sx={{ flexShrink: 0 }}
        >
          {pendingStartWarning ? 'Start delayed' : 'Waiting to start'}
        </Chip>
      )}
      {isOnline && showHmsErrors && status?.hmsErrors && status.hmsErrors.length > 0 && (
        <PrinterErrorChip
          chipLabel={status.hmsErrors.length > 1 ? `HMS ${status.hmsErrors.length}` : 'HMS'}
          menuTitle={status.hmsErrors.length > 1 ? `${status.hmsErrors.length} HMS alerts` : 'HMS alert'}
          errors={status.hmsErrors}
          printerModel={printerModel}
          printerSerial={printerSerial}
        />
      )}
      {isOnline && status?.connectionWarnings && status.connectionWarnings.length > 0 && (
        <Tooltip
          variant="soft"
          size="sm"
          title={status.connectionWarnings.map((warning) => warning.message).join(' ')}
        >
          <Chip
            size="sm"
            variant="soft"
            color="warning"
            startDecorator={<WarningAmberRoundedIcon />}
            sx={{ flexShrink: 0 }}
          >
            LAN mode
          </Chip>
        </Tooltip>
      )}
    </>
  )
}
