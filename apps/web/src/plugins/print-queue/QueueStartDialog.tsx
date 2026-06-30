/**
 * Single-item "Start print" dialog for the print queue.
 *
 * Lets the user pick a connected, idle printer and map each required filament to an AMS slot — reusing
 * the print dialog's {@link PrinterMapping} — so a queued item can run even when no printer has the exact
 * sliced material loaded. Printers are listed most-ready-first with per-aspect match chips (model /
 * nozzle / material) so it's obvious which printer needs the least fiddling. The slot picker is pre-filled
 * from the automatic match for the chosen printer (so a fully-loaded printer is one click); the user can
 * re-pick any slot. Starting dispatches the explicit printer + mapping, which the server honours verbatim
 * (skipping the strict material match).
 */
import { useMemo, useState } from 'react'
import { Alert, Button, DialogActions, DialogContent, DialogTitle, FormControl, FormLabel, ModalDialog, Option, Select, Stack, Typography } from '@mui/joy'
import {
  evaluateQueueMatch,
  loadedSlotsFromStatus,
  type Printer,
  type PrinterStatus,
  type QueueItem,
  type ThreeMfProjectFilament
} from '@printstream/shared'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { FilamentSpoolIcon } from '../../components/FilamentSpoolIcon'
import { PrinterMapping } from '../../components/library/PrinterMapping'
import { matchPrinterAspects, type PrinterAspectMatch } from './printerAspectMatch'
import { MatchChip } from './MatchChip'

/** Printer name + its per-aspect match chips — rendered both inside each dropdown option and as the
 *  selected value, so the chosen printer (and how ready it is) is always visible on the closed picker. */
function PrinterOptionRow({ name, match }: { name: string; match: PrinterAspectMatch }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ width: '100%', minWidth: 0 }}>
      <Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>{name}</Typography>
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ justifyContent: 'flex-end' }}>
        <MatchChip label={match.modelLabel} state={match.model} />
        <MatchChip label={match.nozzleLabel} state={match.nozzle} />
        <MatchChip label={match.plateLabel} state={match.plate} />
        <MatchChip label={match.materialLabel} state={match.material} icon={<FilamentSpoolIcon />} />
      </Stack>
    </Stack>
  )
}

/** Adapt the queue item's required filaments to the shape `PrinterMapping` renders (no per-filament nozzle). */
function toMappingFilaments(item: QueueItem): ThreeMfProjectFilament[] {
  return item.requiredFilaments.map((filament) => ({
    id: filament.id,
    filamentType: filament.filamentType,
    filamentName: filament.filamentName ?? null,
    color: filament.color,
    nozzleId: null,
    chamberTemperature: null
  }))
}

function baseMapping(item: QueueItem): number[] {
  const maxId = item.requiredFilaments.reduce((max, filament) => Math.max(max, filament.id), 0)
  return new Array<number>(maxId).fill(-1)
}

export function QueueStartDialog({
  item,
  printers,
  statuses,
  allowTypeOnlyMatch,
  busy,
  onStart,
  onClose
}: {
  item: QueueItem
  printers: Printer[]
  statuses: Record<string, PrinterStatus>
  allowTypeOnlyMatch: boolean
  busy: boolean
  onStart: (printerId: string, amsMapping: number[]) => void
  onClose: () => void
}) {
  const filaments = useMemo(() => toMappingFilaments(item), [item])

  // Grams each required filament needs (from the slice), keyed by project filament id, so the slot picker
  // can show "how much is needed" and grade each slot's remaining quantity against it.
  const usedGramsById = useMemo(() => {
    const map = new Map<number, number>()
    for (const filament of item.requiredFilaments) {
      if (filament.usedGrams != null) map.set(filament.id, filament.usedGrams)
    }
    return map
  }, [item])

  // Printers the user can start on right now — connected, idle, model-compatible, and not excluded by a
  // pinned target — ranked most-ready first (the one needing the fewest material overrides leads).
  const ranked = useMemo(() => printers
    .map((printer) => ({ printer, match: matchPrinterAspects(item, printer, statuses[printer.id], allowTypeOnlyMatch) }))
    .filter(({ printer, match }) => {
      if (!match.idle || match.model === 'mismatch') return false
      if (item.target.kind === 'printer' && item.target.printerId && printer.id !== item.target.printerId) return false
      if (item.target.kind === 'model' && item.target.model && printer.model !== item.target.model) return false
      return true
    })
    .sort((left, right) => right.match.score - left.match.score), [printers, statuses, item, allowTypeOnlyMatch])

  // Auto-match the materials so a printer that already has them pre-fills every slot (and a partial
  // match pre-fills what it can); the user only picks the slots the match left at -1.
  const autoMappingFor = useMemo(() => {
    const cache = new Map<string, number[]>()
    return (printerId: string): number[] => {
      const cached = cache.get(printerId)
      if (cached) return cached
      const status = statuses[printerId]
      const mapping = status
        ? evaluateQueueMatch(item.requiredFilaments, loadedSlotsFromStatus(status), { allowTypeOnlyMatch }).amsMapping
        : baseMapping(item)
      cache.set(printerId, mapping)
      return mapping
    }
  }, [statuses, item, allowTypeOnlyMatch])

  const defaultPrinterId = ranked[0]?.printer.id ?? null
  const [picked, setPicked] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, number[]>>({})
  const selectedPrinterId = picked && ranked.some((entry) => entry.printer.id === picked) ? picked : defaultPrinterId

  const autoMapping = selectedPrinterId ? autoMappingFor(selectedPrinterId) : baseMapping(item)
  const mapping = (selectedPrinterId && edits[selectedPrinterId]) || autoMapping
  const selectedPrinter = printers.find((printer) => printer.id === selectedPrinterId) ?? null
  const allMapped = item.requiredFilaments.every((filament) => (mapping[filament.id - 1] ?? -1) >= 0)

  const handleMappingChange = (filamentId: number, tray: number) => {
    if (!selectedPrinterId) return
    setEdits((prev) => {
      const current = prev[selectedPrinterId] ?? autoMapping
      const next = [...current]
      next[filamentId - 1] = tray
      return { ...prev, [selectedPrinterId]: next }
    })
  }

  const printedName = item.label ?? item.fileName.replace(/\.(gcode\.3mf|gcode|3mf)$/i, '')

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 520, width: '100%' }}>
        <DialogTitle>Start print — {printedName}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            {ranked.length === 0 ? (
              <Alert color="warning" variant="soft">
                No connected, idle printer can start this right now. Free up a printer (or connect one) and try again.
              </Alert>
            ) : (
              <>
                {/* Plain facts about the print; the printer dropdown above shows which printers satisfy them. */}
                {item.compatibleModels.length > 0 || item.nozzleDiameters.length > 0 || item.plateType || item.requiredFilaments.length > 0 ? (
                  <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                    {item.compatibleModels.length > 0 ? <MatchChip label={item.compatibleModels.join('/')} state="info" /> : null}
                    {item.nozzleDiameters.length > 0 ? <MatchChip label={`${item.nozzleDiameters.join('/')} mm`} state="info" /> : null}
                    {item.plateType ? <MatchChip label={item.plateType} state="info" /> : null}
                    {item.requiredFilaments.length > 0 ? <MatchChip label={`${item.requiredFilaments.length} material${item.requiredFilaments.length === 1 ? '' : 's'}`} state="info" icon={<FilamentSpoolIcon />} /> : null}
                  </Stack>
                ) : null}

                <FormControl size="sm">
                  <FormLabel>Printer — most ready first</FormLabel>
                  <Select
                    value={selectedPrinterId}
                    onChange={(_event, value) => { if (value) setPicked(value) }}
                    slotProps={{ button: { sx: { minHeight: 36, py: 0.5 } }, listbox: { sx: { maxWidth: 'min(92vw, 480px)' } } }}
                    renderValue={(option) => {
                      const entry = ranked.find((candidate) => candidate.printer.id === option?.value)
                      return entry ? <PrinterOptionRow name={entry.printer.name} match={entry.match} /> : null
                    }}
                  >
                    {ranked.map(({ printer, match }) => (
                      <Option key={printer.id} value={printer.id} label={printer.name} sx={{ alignItems: 'stretch' }}>
                        <PrinterOptionRow name={printer.name} match={match} />
                      </Option>
                    ))}
                  </Select>
                </FormControl>

                {filaments.length > 0 && selectedPrinter ? (
                  <>
                    <Typography level="body-xs" textColor="text.tertiary">
                      Assign each material to a slot. Slots that aren't an exact match are flagged but can still be used.
                    </Typography>
                    <PrinterMapping
                      printer={selectedPrinter}
                      status={selectedPrinterId ? statuses[selectedPrinterId] : undefined}
                      filaments={filaments}
                      usedGramsById={usedGramsById}
                      mapping={mapping}
                      issues={EMPTY_ISSUES}
                      onChange={handleMappingChange}
                    />
                  </>
                ) : (
                  <Typography level="body-xs" textColor="text.tertiary">
                    This print has no material requirements — start it on the selected printer.
                  </Typography>
                )}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
          <Button
            color="primary"
            loading={busy}
            disabled={!selectedPrinterId || !allMapped || busy}
            onClick={() => { if (selectedPrinterId) onStart(selectedPrinterId, mapping) }}
          >
            Start print
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}

const EMPTY_ISSUES: never[] = []
