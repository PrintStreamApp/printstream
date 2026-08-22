/**
 * Presentation helpers for the Filament Track Switch (FTS) surfaces: the printer
 * card chip and the controls-dialog section. Pure formatting only.
 *
 * The SEMANTICS (readiness, reachability, which extruder an input feeds) live in
 * `@printstream/shared`'s `filament-track-switch.ts` — this module only turns
 * them into words, so a rule cannot drift between the UI and the API. The data
 * comes from `PrinterStatus.filamentTrackSwitch`, which is `null` on every
 * machine without the module, so callers must null-check first.
 */
import {
  extruderIdForSwitchInput,
  formatNozzleLabel,
  type FilamentTrackSwitch,
  type FilamentTrackSwitchInput,
  type FilamentTrackSwitchSummary
} from '@printstream/shared'
import { amsUnitLetter } from './printerTrayMapping'

/**
 * Where an input's filament comes from, e.g. `AMS B · Slot 3`. `null` when
 * nothing is docked to that input — rendered as "Not connected" rather than
 * omitted, because an empty input is a real state the user may need to fix.
 */
export function formatSwitchInputSource(slot: { amsId: number; slotId: number } | null): string | null {
  if (!slot) return null
  return `AMS ${amsUnitLetter(slot.amsId)} · Slot ${slot.slotId + 1}`
}

/**
 * Where an input's filament goes, e.g. `Left nozzle`. `null` when the output is
 * unmapped (`0xE` on the wire), which is what an un-set-up switch reports.
 */
export function formatSwitchOutputTarget(
  trackSwitch: FilamentTrackSwitch,
  input: FilamentTrackSwitchInput,
  nozzleCount?: number | null
): string | null {
  return formatNozzleLabel(extruderIdForSwitchInput(trackSwitch, input), 'long', nozzleCount)
}

/**
 * Compact state label for the card chip and the section header. Ordered by what
 * the user most needs to act on: a switch mid-calibration is busy, an installed
 * switch that is not set up is the state that blocks loading and printing.
 */
export function formatFilamentTrackSwitchState(summary: FilamentTrackSwitchSummary): string {
  if (summary.calibrating) return 'Calibrating'
  if (!summary.installed) return 'Not fitted'
  if (!summary.ready) return 'Not set up'
  return 'Ready'
}

/** Tone for the state chip: the "not set up" state is a warning, not a failure. */
export function filamentTrackSwitchStateColor(
  summary: FilamentTrackSwitchSummary
): 'primary' | 'warning' | 'success' | 'neutral' {
  if (summary.calibrating) return 'primary'
  if (!summary.installed) return 'neutral'
  if (!summary.ready) return 'warning'
  return 'success'
}

/** One row of the section: an input, what feeds it, and what it drives. */
export interface FilamentTrackSwitchInputRow {
  input: FilamentTrackSwitchInput
  /** AMS slot docked to this input, already formatted; `null` when nothing is. */
  source: string | null
  /** Nozzle this input currently feeds, already formatted; `null` when unmapped. */
  target: string | null
  /** AMS units routed through this input, as `A`/`B` letters. */
  unitLetters: string[]
}

/**
 * Build both input rows in a fixed A-then-B order. Deliberately NOT the wire
 * order — `fila_switch.in`/`out` are B-first (see the parser), and surfacing
 * that ordering quirk to the user would be meaningless.
 */
export function buildFilamentTrackSwitchRows(
  trackSwitch: FilamentTrackSwitch,
  summary: FilamentTrackSwitchSummary,
  nozzleCount?: number | null
): FilamentTrackSwitchInputRow[] {
  return (['A', 'B'] as const).map((input) => ({
    input,
    source: formatSwitchInputSource(input === 'A' ? trackSwitch.inputA : trackSwitch.inputB),
    target: formatSwitchOutputTarget(trackSwitch, input, nozzleCount),
    unitLetters: summary.unitsByInput[input].map((unitId) => amsUnitLetter(unitId))
  }))
}
