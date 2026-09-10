/**
 * "Bambu does not support this material here" notice, shared by the library print dialog
 * (`components/library/PrintModal`) and the printer-storage print dialog
 * (`components/StoragePrintModal`).
 *
 * Which rules fired is `checkPrinterFilamentBlacklist`'s call and each sentence is the shared rule
 * text, the same two the API's `assertFilamentBlacklist` refuses from, so a dispatch can never be
 * blocked by a check this alert did not show.
 *
 * Renders as TWO alerts, not one, because the rule set carries two severities that ask different
 * things of the user:
 *
 * - A PROHIBITION is hardware Bambu says to avoid (TPU through an AMS, an abrasive through an E3D
 *   high-flow nozzle). It gates the Print button and its confirm is bound to
 *   `allowBlacklistedFilament`. BambuStudio refuses these outright; we offer the override because
 *   the rules key on a nozzle flow and diameter we DECODE, and a misread nozzle must not make a
 *   correct setup un-printable.
 * - A WARNING is handling advice ("cold pull before printing TPU", "dry PVA first"). There is
 *   nothing to accept and nothing to refuse, so it carries no checkbox and never blocks. Folding
 *   the two together would either ground ordinary TPU and CF prints, or leave one checkbox
 *   claiming to cover a risk the user was never shown.
 *
 * The confirm is bound to `allowBlacklistedFilament` and NOT to `allowIncompatibleFilament`: that
 * one means "the trays I picked hold what the file wants", a statement about the FILE, while this
 * accepts a risk to the PRINTER. One checkbox must not grant both.
 *
 * Renders nothing when no rule matched, so callers can mount it unconditionally.
 */
import { Alert, Checkbox, Link, Stack, Typography } from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import type { FilamentBlacklistFinding } from '@printstream/shared'
import type { FilamentBlacklistEntry } from '../lib/filamentBlacklist'

/** One sentence, with Bambu's help page behind it when the rule names one. */
function FindingLine({ finding }: { finding: FilamentBlacklistFinding }) {
  return (
    <Typography level="body-xs">
      {finding.message}
      {finding.wikiUrl ? (
        <>
          {' '}
          <Link href={finding.wikiUrl} target="_blank" rel="noreferrer">Learn more</Link>
        </>
      ) : null}
    </Typography>
  )
}

/** The per-printer, per-slot body both severities share. */
function FindingGroups({
  entries,
  pick
}: {
  entries: FilamentBlacklistEntry[]
  pick: (slot: FilamentBlacklistEntry['slots'][number]) => FilamentBlacklistFinding[]
}) {
  return (
    <>
      {entries.map((entry) => {
        const slots = entry.slots.filter((slot) => pick(slot).length > 0)
        if (slots.length === 0) return null
        return (
          <Stack key={entry.printerId} spacing={0.25}>
            {entry.printerName ? (
              <Typography level="body-sm" fontWeight="lg">{entry.printerName}</Typography>
            ) : null}
            {slots.map((slot) => (
              <Stack key={slot.trayIndex} spacing={0.25}>
                <Typography level="body-xs" fontWeight="lg">{slot.slotLabel}</Typography>
                {pick(slot).map((finding) => (
                  <FindingLine key={finding.message} finding={finding} />
                ))}
              </Stack>
            ))}
          </Stack>
        )
      })}
    </>
  )
}

export function FilamentBlacklistAlert({
  entries,
  confirmed,
  onConfirmedChange
}: {
  entries: FilamentBlacklistEntry[]
  confirmed: boolean
  onConfirmedChange: (next: boolean) => void
}) {
  const withProhibitions = entries.filter((entry) =>
    entry.slots.some((slot) => slot.prohibitions.length > 0))
  const withWarnings = entries.filter((entry) =>
    entry.slots.some((slot) => slot.warnings.length > 0))
  if (withProhibitions.length === 0 && withWarnings.length === 0) return null

  return (
    <Stack spacing={1}>
      {withProhibitions.length > 0 ? (
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
          <Stack spacing={1} sx={{ width: '100%' }}>
            <Typography level="title-sm">Unsupported material for this printer</Typography>
            <Typography level="body-sm">
              Bambu does not support printing this material from the selected slot, and doing so can
              damage the printer. Load a supported filament, move the spool to an external spool
              holder, or confirm below to print anyway.
            </Typography>
            <FindingGroups entries={withProhibitions} pick={(slot) => slot.prohibitions} />
            <Checkbox
              label="Print anyway with an unsupported material"
              checked={confirmed}
              onChange={(event) => onConfirmedChange(event.target.checked)}
            />
          </Stack>
        </Alert>
      ) : null}
      {withWarnings.length > 0 ? (
        <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
          <Stack spacing={1} sx={{ width: '100%' }}>
            <Typography level="title-sm">Handle this material with care</Typography>
            <Typography level="body-sm">
              This print can go ahead. Bambu recommends the following for the materials loaded.
            </Typography>
            <FindingGroups entries={withWarnings} pick={(slot) => slot.warnings} />
          </Stack>
        </Alert>
      ) : null}
    </Stack>
  )
}
