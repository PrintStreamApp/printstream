/**
 * The rows inside the AMS settings sheet (`AmsModals`' `AmsSettingsModal`).
 *
 * Split out of `AmsModals.tsx` when the sheet grew past one row SHAPE. Both share
 * `AmsSettingsRowLayout` rather than each re-stating the title/description/controls grid, because
 * they sit in one divided `Sheet` and any drift between them reads as a rendering bug: the label
 * column has to line up and the controls have to stack the same way on a phone.
 *
 * The two shapes, and why each exists:
 * - `AmsSettingsRow` -- a boolean the printer reports and we toggle (read-on-insert, backup).
 * - `AmsOrderResetRow` -- a one-shot ACTION with no state to show, for renumbering the chain.
 *
 * Counterpart: `apps/api/src/routes/printers.ts` validates each of these commands, and refuses the
 * same cases the controls disable themselves for. The disabling here is an affordance, not the
 * guard: the API is authoritative and a stale status must not be able to send a bad command.
 */
import { Button, Chip, Stack, Typography } from '@mui/joy'
import type { ReactNode } from 'react'

/** The shared grid: label column that wraps, controls that drop below it on a phone. */
function AmsSettingsRowLayout({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.25}
      justifyContent="space-between"
      alignItems={{ xs: 'stretch', sm: 'center' }}
      sx={{ p: 1.25 }}
    >
      <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
        <Typography level="title-sm">{title}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">{description}</Typography>
      </Stack>
      <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center">
        {children}
      </Stack>
    </Stack>
  )
}

export function AmsSettingsRow({
  title,
  description,
  value,
  disabled,
  unsupported = false,
  onToggle
}: {
  title: string
  description: string
  value: boolean | null
  disabled: boolean
  unsupported?: boolean
  onToggle: (nextValue: boolean) => void
}) {
  const stateLabel = unsupported ? 'Unsupported' : value == null ? 'Unknown' : value ? 'On' : 'Off'
  const color: 'neutral' | 'success' = !unsupported && value ? 'success' : 'neutral'

  return (
    <AmsSettingsRowLayout title={title} description={description}>
      <Chip size="sm" variant="soft" color={color}>{stateLabel}</Chip>
      {!unsupported && (
        <Button size="sm" variant="soft" disabled={disabled} onClick={() => onToggle(!(value ?? false))}>
          {value ? 'Disable' : 'Enable'}
        </Button>
      )}
    </AmsSettingsRowLayout>
  )
}

/**
 * Reset the AMS chain's id sequence, so units can be reconnected in a chosen order.
 *
 * A2L only, and the caller decides that from `supportsAmsSettingsReorder`: BambuStudio gates the
 * same panel on a static per-model config key rather than anything the printer reports.
 *
 * The button says "Reset" and the copy explains the reconnect, mirroring Studio. Worth knowing
 * that Studio's own body text says "Reconnect" while its button says "Reset"; we use one word for
 * both so the control and the sentence describing it cannot disagree.
 */
export function AmsOrderResetRow({
  disabled,
  onReset
}: {
  disabled: boolean
  onReset: () => void
}) {
  return (
    <AmsSettingsRowLayout
      title="Arrange AMS order"
      description="Disconnects every AMS unit at once. Reconnect them one at a time, in the order you want them numbered."
    >
      <Button size="sm" variant="soft" color="warning" disabled={disabled} onClick={onReset}>
        Reset
      </Button>
    </AmsSettingsRowLayout>
  )
}
