/**
 * "Moving a spool would speed this print up" hint, shared by the library print dialog
 * (`components/library/PrintModal`) and the printer-storage print dialog
 * (`components/StoragePrintModal`).
 *
 * Which spools and where is `filamentTrackSwitchArrangement`'s call and each sentence is
 * `filamentTrackSwitchMoveSentence`'s, both shared.
 *
 * ADVISORY ONLY, and deliberately so. It carries no checkbox, gates no button, and there is
 * nothing for the API to enforce: rearranging spools is a physical act, and BambuStudio's own
 * version of this dialog likewise offers only a diagram and a Close button. That is why it renders
 * as `neutral` rather than `warning`: nothing here is wrong, and dressing an optimisation as a
 * problem would train people to ignore the alerts that are.
 *
 * Renders nothing when there is no suggestion, or when the spools are already arranged well, so
 * callers can mount it unconditionally.
 *
 * INERT TODAY: no shipping firmware reports a Filament Track Switch, so the shared rule returns
 * null on every printer and this never appears.
 */
import { Alert, Stack, Typography } from '@mui/joy'
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined'
import { filamentTrackSwitchMoveSentence, type FilamentTrackSwitchMove } from '@printstream/shared'

export interface FilamentTrackSwitchArrangementEntry {
  printerId: string
  /** Omitted when the dialog targets one printer and a heading would be noise. */
  printerName?: string | null
  moves: FilamentTrackSwitchMove[]
  /** How this dialog names the slot behind a tray index ("AMS A Slot 2"). */
  slotLabel: (trayIndex: number) => string
}

export function FilamentTrackSwitchArrangementAlert({
  entries
}: {
  entries: FilamentTrackSwitchArrangementEntry[]
}) {
  const withMoves = entries.filter((entry) => entry.moves.length > 0)
  if (withMoves.length === 0) return null

  return (
    <Alert color="neutral" variant="soft" startDecorator={<LightbulbOutlinedIcon />}>
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Typography level="title-sm">A different spool arrangement would be faster</Typography>
        <Typography level="body-sm">
          This print can go ahead as it is. Moving the spools below to an AMS on the other Filament
          Track Switch inlet would mean fewer filament changes.
        </Typography>
        {withMoves.map((entry) => (
          <Stack key={entry.printerId} spacing={0.25}>
            {entry.printerName ? (
              <Typography level="body-sm" fontWeight="lg">{entry.printerName}</Typography>
            ) : null}
            {entry.moves.map((move) => (
              <Typography key={move.filamentId} level="body-xs">
                {filamentTrackSwitchMoveSentence(move, entry.slotLabel(move.trayIndex))}
              </Typography>
            ))}
          </Stack>
        ))}
      </Stack>
    </Alert>
  )
}
