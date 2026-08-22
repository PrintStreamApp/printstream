/**
 * "This was sliced for a different machine" warning, shared by the library print dialog
 * (`components/library/PrintModal`) and the printer-storage print dialog
 * (`components/StoragePrintModal`).
 *
 * A file sliced for a machine with a Filament Track Switch groups its filaments across the two
 * extruders differently from one sliced without, and the tool changes baked into the g-code assume
 * one of them. BambuStudio refuses the mismatch outright; we warn and let the user proceed (see
 * `assertFilamentTrackSwitchMatch` in the API for why the hard block is not safe for us).
 *
 * Its confirm is bound to `allowFilamentTrackSwitchMismatch`, NOT to the tray dialogs'
 * `allowIncompatibleFilament` — accepting the trays you picked is a different judgement from
 * accepting a file sliced for another class of machine, and one checkbox must not grant both.
 *
 * Renders nothing when there is no mismatch, so callers can mount it unconditionally.
 */
import { Alert, Checkbox, Stack, Typography } from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { filamentTrackSwitchMismatchDetail } from '@printstream/shared'

export interface FilamentTrackSwitchMismatchEntry {
  printerId: string
  printerName: string
  /** The PRINTER's side of the disagreement; the file's is its opposite. */
  printerHasSwitch: boolean
}

export function FilamentTrackSwitchMismatchAlert({
  entries,
  confirmed,
  onConfirmedChange
}: {
  entries: FilamentTrackSwitchMismatchEntry[]
  confirmed: boolean
  onConfirmedChange: (next: boolean) => void
}) {
  if (entries.length === 0) return null

  return (
    <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Typography level="title-sm">Sliced for a different machine</Typography>
        <Typography level="body-sm">
          Slice this file again for the printer you are sending it to, or confirm below to print it
          as it is.
        </Typography>
        {entries.map((entry) => (
          <Stack key={entry.printerId} spacing={0.25}>
            <Typography level="body-sm" fontWeight="lg">{entry.printerName}</Typography>
            <Typography level="body-xs">
              This file was {filamentTrackSwitchMismatchDetail(entry.printerHasSwitch)}.
            </Typography>
          </Stack>
        ))}
        <Checkbox
          label="Print anyway on a machine it was not sliced for"
          checked={confirmed}
          onChange={(event) => onConfirmedChange(event.target.checked)}
        />
      </Stack>
    </Alert>
  )
}
