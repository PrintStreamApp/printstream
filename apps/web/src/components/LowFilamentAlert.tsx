/**
 * "A slot you picked will run out" warning, shared by the library print dialog
 * (`components/library/PrintModal`), the printer-storage print dialog
 * (`components/StoragePrintModal`) and the queue's start dialog
 * (`plugins/print-queue/QueueStartDialog`).
 *
 * Which slots are short is `findLowFilamentSlots`' call and each sentence is
 * `lowFilamentIssueSentence`'s — the same two the API's `assertSufficientFilament` refuses from, so
 * a dispatch can never be blocked by a check this alert did not show. A slot the printer's
 * auto-refill chains to a mate is judged on the pool's combined remaining, so a backed-up slot
 * appears here only when the whole pool falls short: that is the "and no backup" half of it.
 *
 * Its confirm is bound to `allowInsufficientFilament`, NOT to `allowIncompatibleFilament` — "these
 * are the right materials" and "enough of them is left" are different judgements, and one checkbox
 * must not grant both.
 *
 * Renders nothing when nothing is short, so callers can mount it unconditionally.
 */
import { Alert, Checkbox, Stack, Typography } from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { lowFilamentIssueSentence, type LowFilamentSlot } from '@printstream/shared'

export interface LowFilamentEntry {
  printerId: string
  /** Omitted when the dialog only ever targets one printer, which then needs no heading. */
  printerName?: string | null
  issues: LowFilamentSlot[]
  /** How this dialog names the slot behind a tray index ("AMS A 2", "External spool"). */
  slotLabel: (trayIndex: number) => string
}

export function LowFilamentAlert({
  entries,
  confirmed,
  onConfirmedChange
}: {
  entries: LowFilamentEntry[]
  confirmed: boolean
  onConfirmedChange: (next: boolean) => void
}) {
  const withIssues = entries.filter((entry) => entry.issues.length > 0)
  if (withIssues.length === 0) return null

  return (
    <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Typography level="title-sm">Not enough filament to finish</Typography>
        <Typography level="body-sm">
          Load more filament, pick a fuller slot, or confirm below to start anyway. The printer
          pauses and waits when a slot runs dry mid-print.
        </Typography>
        {withIssues.map((entry) => (
          <Stack key={entry.printerId} spacing={0.25}>
            {entry.printerName ? (
              <Typography level="body-sm" fontWeight="lg">{entry.printerName}</Typography>
            ) : null}
            {entry.issues.map((issue) => (
              <Typography key={issue.filamentId} level="body-xs">
                {lowFilamentIssueSentence(issue, entry.slotLabel(issue.trayIndex))}
              </Typography>
            ))}
          </Stack>
        ))}
        <Checkbox
          label="Start anyway with these slots"
          checked={confirmed}
          onChange={(event) => onConfirmedChange(event.target.checked)}
        />
      </Stack>
    </Alert>
  )
}
