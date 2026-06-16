/**
 * Inline panel that surfaces live filament-change progress on a printer card:
 * a one-line summary (live step label, stage fallback, or a pending-action
 * placeholder) plus the ordered step list with done/active/pending state.
 * Pure presentational component driven entirely by props.
 */
import { Alert, Chip, Sheet, Stack, Typography } from '@mui/joy'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { isPrinterActiveJobStage, type PrinterStatus } from '@printstream/shared'
import { formatSecondaryStageLabel } from '../../lib/printerProgressSummary'

export function FilamentChangeProgressPanel({
  status,
  pendingActionLabel
}: {
  status: PrinterStatus | undefined
  pendingActionLabel: string | null
}) {
  const filamentChange = status?.filamentChange
  const canUseStageFallback = status != null && (status.stage === 'paused' || isPrinterActiveJobStage(status.stage))
  const liveLabel = filamentChange?.currentStepLabel ?? (canUseStageFallback ? formatSecondaryStageLabel(status) : null)
  const summary = liveLabel ?? (pendingActionLabel ? `${pendingActionLabel} requested. Waiting for printer...` : null)
  const steps = filamentChange?.steps ?? []
  const currentStepIndex = filamentChange?.currentStepIndex ?? null
  if (!summary && steps.length === 0) return null

  return (
    <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'sm', display: 'grid', gap: 1 }}>
      <Typography level="title-sm">Filament change progress</Typography>
      {summary && (
        <Alert size="sm" color="primary" variant="soft" startDecorator={<InfoOutlinedIcon />}>
          {summary}
        </Alert>
      )}
      {steps.length > 0 && (
        <Stack spacing={0.75}>
          {steps.map((step, index) => {
            const state = currentStepIndex == null
              ? 'pending'
              : index < currentStepIndex
                ? 'done'
                : index === currentStepIndex
                  ? 'active'
                  : 'pending'

            return (
              <Stack key={`${step}-${index}`} direction="row" spacing={1} alignItems="center">
                <Chip
                  size="sm"
                  color={state === 'done' ? 'success' : state === 'active' ? 'primary' : 'neutral'}
                  variant={state === 'pending' ? 'outlined' : 'soft'}
                >
                  {index + 1}
                </Chip>
                <Typography
                  level="body-sm"
                  textColor={state === 'pending' ? 'text.tertiary' : 'text.primary'}
                  fontWeight={state === 'active' ? 'lg' : 'md'}
                >
                  {step}
                </Typography>
              </Stack>
            )
          })}
        </Stack>
      )}
    </Sheet>
  )
}
