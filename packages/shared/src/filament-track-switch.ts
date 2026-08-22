/**
 * Single source of truth for what a Filament Track Switch (FTS) MEANS once its
 * state has been parsed — readiness, reachability, and the extruder an input
 * ultimately feeds. Parsing lives in the API's `bambu-report-parser.ts`; every
 * surface that has to *decide* something from `PrinterStatus.filamentTrackSwitch`
 * comes here instead of re-deriving it.
 *
 * The FTS is a 2-in/2-out routing module between AMS units and the two nozzles
 * of a dual-nozzle machine. An AMS behind it can feed EITHER nozzle, which is
 * why it changes tray-picker reachability, queue matching, and what we tell the
 * slicer about the machine.
 *
 * Contract mirrored from BambuStudio (`DevFilaSwitch`, `SelectMachineDialog`):
 *   - readiness is `DevFilaSwitch::IsReady` — installed is NOT enough, because a
 *     switch that has not been set up on the printer routes nothing;
 *   - a file sliced for an FTS machine must not print on a non-FTS machine, and
 *     vice versa (`SelectMachine.cpp` refuses the mismatch outright).
 *
 * Assumes at most one FTS per printer, which is all the wire contract can
 * express (`device.fila_switch` is a single object); revisit if Bambu ships a
 * daisy-chained module.
 */
import type { AmsUnit, FilamentTrackSwitch, PrinterStatus } from './printer-contracts.js'

/** The switch's two AMS-side inputs. */
export type FilamentTrackSwitchInput = 'A' | 'B'

/**
 * Is the switch set up well enough to route filament? Mirrors
 * `DevFilaSwitch::IsReady`: installed, and every AMS unit reports which switch
 * input it is docked to. An installed-but-unconfigured switch is the state
 * Studio blocks loading/unloading on ("has not been setup. Please setup on
 * printer"), so treat `installed` alone as "hardware seen", never as "usable".
 *
 * `false` whenever no switch is reported at all, so callers can use this as the
 * single gate without a separate null check.
 *
 * UNVERIFIED against firmware (none ships FTS support yet), and the strict
 * every-unit rule is the part most likely to be wrong: a machine with more AMS
 * units than the switch's two inputs would never read as ready here. That is
 * what Studio does, so it is what we do — but if a real payload shows units
 * legitimately sitting outside the switch, relax this to the units that report
 * an input rather than inventing a different rule.
 */
export function isFilamentTrackSwitchReady(status: {
  filamentTrackSwitch?: FilamentTrackSwitch | null
  ams: Pick<AmsUnit, 'switchInput'>[]
}): boolean {
  const trackSwitch = status.filamentTrackSwitch
  if (!trackSwitch?.installed) return false
  // Studio requires EVERY unit to name its input; a unit that does not is one
  // the printer cannot route, which makes the whole switch unusable.
  return status.ams.every((unit) => unit.switchInput != null)
}

/** Is an FTS physically present, regardless of whether it has been set up? */
export function isFilamentTrackSwitchInstalled(status: {
  filamentTrackSwitch?: FilamentTrackSwitch | null
}): boolean {
  return status.filamentTrackSwitch?.installed === true
}

/**
 * Extruder id the given switch input ultimately feeds, or `null` when the
 * output is unmapped. Note this is the CURRENT routing: the point of the switch
 * is that it can be re-routed mid-print, so never cache this as a slot's fixed
 * nozzle binding — use {@link isDualReachableAmsUnit} for reachability.
 */
export function extruderIdForSwitchInput(
  trackSwitch: FilamentTrackSwitch,
  input: FilamentTrackSwitchInput
): number | null {
  return input === 'A' ? trackSwitch.outputAExtruderId : trackSwitch.outputBExtruderId
}

/**
 * Can this AMS unit feed either nozzle? True for any unit docked to a switch
 * input. Such a unit deliberately carries a `null` `nozzleId` — a hard nozzle
 * binding would filter it out of pickers it belongs in.
 */
export function isDualReachableAmsUnit(unit: Pick<AmsUnit, 'switchInput'>): boolean {
  return unit.switchInput != null
}

/**
 * The nozzle a unit is bound to for mapping purposes: `null` (= any) when the
 * unit sits behind the switch, otherwise its reported binding. Re-derived here
 * rather than trusted from `nozzleId` alone so a stale binding left over from
 * before the switch was fitted can never re-introduce a constraint the hardware
 * no longer has.
 */
export function effectiveAmsNozzleId(unit: Pick<AmsUnit, 'switchInput' | 'nozzleId'>): number | null {
  return isDualReachableAmsUnit(unit) ? null : unit.nozzleId
}

/**
 * Does a sliced file's FTS expectation match the printer it is about to print
 * on? BambuStudio refuses the mismatch in both directions (`SelectMachine.cpp`:
 * `slicing_with_fila_switch() != GetFilaSwitch()->IsInstalled()`), because the
 * two cases produce different filament-to-extruder groupings and the tool
 * changes baked into the g-code assume one of them.
 *
 * `slicedWithSwitch` is what the file was sliced for (`has_filament_switcher`
 * in its project config); `null` means the file predates the flag and is
 * treated as "no switch", exactly as an absent config option reads in Studio.
 */
export function filamentTrackSwitchMatchesSlice(
  slicedWithSwitch: boolean | null | undefined,
  printerHasSwitch: boolean
): boolean {
  return (slicedWithSwitch ?? false) === printerHasSwitch
}

/**
 * Should a surface warn that this file and this printer disagree about the switch?
 *
 * The ONE rule every print surface uses — the two dialogs and the API guard — so a dispatch can
 * never be refused by a check the dialog did not show, or vice versa. Returns the printer's side of
 * the mismatch (`printerHasSwitch`) so callers can phrase it, or `null` when there is nothing to
 * say.
 *
 * Returns `null` for both kinds of "unknown", which are NOT the same as agreement:
 *   - no printer status, or a printer that never mentions an FTS (`null` on the wire) — today that
 *     is every machine, since no firmware reports one;
 *   - a file whose flag is `undefined`, meaning an older server did not send it. `false` is a real
 *     answer ("sliced without a switch"); `undefined` is the absence of one, and warning on it
 *     would fire on every file served by a lagging deployment.
 */
export function filamentTrackSwitchMismatch(
  slicedWithSwitch: boolean | null | undefined,
  status: { filamentTrackSwitch?: FilamentTrackSwitch | null } | null | undefined
): { printerHasSwitch: boolean } | null {
  if (!status || status.filamentTrackSwitch == null) return null
  if (slicedWithSwitch === undefined) return null
  const printerHasSwitch = isFilamentTrackSwitchInstalled(status)
  if (filamentTrackSwitchMatchesSlice(slicedWithSwitch, printerHasSwitch)) return null
  return { printerHasSwitch }
}

/**
 * The mismatch itself, as a clause and with no instruction attached — for a dialog that offers its
 * own confirm control and would read oddly if the text also told the user to confirm.
 */
export function filamentTrackSwitchMismatchDetail(printerHasSwitch: boolean): string {
  return printerHasSwitch
    ? 'sliced without a Filament Track Switch, but this printer has one fitted'
    : 'sliced for a printer with a Filament Track Switch, which this printer does not have'
}

/**
 * Why a print was refused for an FTS mismatch, phrased for the user. Composed from
 * {@link filamentTrackSwitchMismatchDetail} so the dispatch refusal and the dialog warning cannot
 * describe the same problem two different ways.
 */
export function filamentTrackSwitchMismatchMessage(printerHasSwitch: boolean): string {
  return `This file was ${filamentTrackSwitchMismatchDetail(printerHasSwitch)}. `
    + 'Slice it again for this printer, or confirm the mismatch to print anyway.'
}

/** Summary of a printer's switch, for status surfaces. */
export interface FilamentTrackSwitchSummary {
  installed: boolean
  /** Set up and routing (see {@link isFilamentTrackSwitchReady}). */
  ready: boolean
  /** True while the switch's own calibration routine is stepping. */
  calibrating: boolean
  /** AMS units docked to each input, in unit-id order. */
  unitsByInput: Record<FilamentTrackSwitchInput, number[]>
}

/** Fold a printer's status into the facts every FTS surface needs. */
export function summarizeFilamentTrackSwitch(
  status: Pick<PrinterStatus, 'ams'> & { filamentTrackSwitch?: FilamentTrackSwitch | null }
): FilamentTrackSwitchSummary | null {
  const trackSwitch = status.filamentTrackSwitch
  if (!trackSwitch) return null
  const unitsByInput: Record<FilamentTrackSwitchInput, number[]> = { A: [], B: [] }
  for (const unit of status.ams) {
    if (unit.switchInput === 'A' || unit.switchInput === 'B') unitsByInput[unit.switchInput].push(unit.unitId)
  }
  for (const input of ['A', 'B'] as const) unitsByInput[input].sort((a, b) => a - b)
  return {
    installed: trackSwitch.installed,
    ready: isFilamentTrackSwitchReady(status),
    calibrating: trackSwitch.calibrating,
    unitsByInput
  }
}
