/**
 * Suggested Filament Track Switch rearrangement: which switch inlet each of a plate's filaments
 * would ideally sit behind, and therefore which spools are worth physically moving.
 *
 * OWNS the port of BambuStudio's `SelectMachineDialog::get_filament_suggest_pos`
 * (`SelectMachine.cpp`). Sibling of `filament-track-switch.ts`, which owns what a switch IS; this
 * module owns only the arrangement question.
 *
 * CONTRACT: `filamentTrackSwitchArrangement` is advisory and NOTHING acts on it. It moves no
 * spool, sends no command, and never gates a print. BambuStudio's dialog is the same: it draws a
 * diagram and a list of moves, and the only buttons are a wiki link and Close. A rearrangement is
 * a physical act, so the most software can honestly do is say which act would help.
 *
 * WHAT IT OPTIMISES, and what it does not. The two-group split is the SLICER's
 * (`optimalAssignment`, computed to minimise tool-change overhead); this module only decides which
 * group goes on which inlet, and it decides that by minimising the number of spools a person has
 * to move. It deliberately ignores material, colour, remaining filament and nozzle bindings,
 * because the grouping that respects those was already made upstream and second-guessing it here
 * would propose moves the slicer's own plan does not want.
 *
 * INVARIANTS, each of which makes the hint go quiet rather than guess:
 *
 * - Every mapped tray's AMS must name an inlet. One unit whose binding we cannot read makes the
 *   whole answer unsound (its filaments would count as "already correct" on both options), so a
 *   single unknown suppresses the hint entirely. Studio bails out on the same condition.
 * - More than two groups is not handled. Studio's function silently returns nothing, and there is
 *   no defined meaning for a third group on a two-inlet switch.
 * - No `optimalAssignment` means the plate was not sliced for a switch. Absent is not "one group".
 *
 * Counterpart: the plate field is parsed by `three-mf/index-parser.ts` from
 * `Metadata/filament_sequence.json`; the browser renders this through
 * `apps/web/src/components/FilamentTrackSwitchArrangementAlert.tsx`.
 *
 * INERT TODAY: no shipping firmware reports a Filament Track Switch, so `switchInput` is null on
 * every unit and this returns null everywhere.
 */
import { amsTrayIndex } from './ams-tray-index.js'
import { isFilamentTrackSwitchInstalled } from './filament-track-switch.js'
import type { PrinterStatus } from './printer-contracts.js'

/** The two AMS-side inputs of the switch, as the printer reports them. */
export type FilamentTrackSwitchInlet = 'A' | 'B'

/** One filament that would be better off behind the other inlet. */
export interface FilamentTrackSwitchMove {
  /** Plate filament id, 1-based, as the print dialogs number filaments. */
  filamentId: number
  /** Bambu global tray index the filament is mapped to today. */
  trayIndex: number
  /** The inlet its AMS sits behind now. */
  currentInlet: FilamentTrackSwitchInlet
  /** The inlet it should sit behind instead. */
  suggestedInlet: FilamentTrackSwitchInlet
}

/** The whole suggestion, or null when there is nothing trustworthy to say. */
export interface FilamentTrackSwitchArrangement {
  /** Suggested inlet per plate filament id. Includes filaments already in the right place. */
  suggestedInletByFilamentId: Map<number, FilamentTrackSwitchInlet>
  /** Only the filaments that would have to move; empty when the layout is already ideal. */
  moves: FilamentTrackSwitchMove[]
}

export interface FilamentTrackSwitchArrangementInput {
  /** The slicer's group id per plate filament, positional. Null/absent suppresses the hint. */
  optimalAssignment: readonly number[] | null | undefined
  status: PrinterStatus | null | undefined
  /** Positional over the plate's filaments, exactly as `ams_mapping` is. */
  amsMapping: readonly number[] | null | undefined
}

/** Which inlet a tray index sits behind, or null when the unit does not say. */
function inletByTrayIndex(status: PrinterStatus): Map<number, FilamentTrackSwitchInlet> {
  const inlets = new Map<number, FilamentTrackSwitchInlet>()
  for (const unit of status.ams) {
    if (unit.switchInput !== 'A' && unit.switchInput !== 'B') continue
    for (const slot of unit.slots) {
      inlets.set(amsTrayIndex(unit.type, unit.unitId, slot.slot), unit.switchInput)
    }
  }
  return inlets
}

/**
 * The suggested inlet per filament, and the moves that would get there.
 *
 * Returns null whenever the answer would be a guess: no switch fitted, no slicer grouping, nothing
 * mapped, a mapped tray behind an AMS that does not report its inlet, or more than two groups.
 * Returning null is meaningfully different from returning an empty `moves` list, which means
 * "checked, and the spools are already arranged well".
 */
export function filamentTrackSwitchArrangement(
  input: FilamentTrackSwitchArrangementInput
): FilamentTrackSwitchArrangement | null {
  const { status, optimalAssignment, amsMapping } = input
  if (!status || !isFilamentTrackSwitchInstalled(status)) return null
  if (!optimalAssignment || optimalAssignment.length === 0) return null
  if (!amsMapping || amsMapping.length === 0) return null

  const inlets = inletByTrayIndex(status)
  // Where each mapped filament sits today. A filament whose AMS does not report an inlet makes the
  // whole comparison unsound, so bail rather than treat it as satisfied on both options.
  const placements: { filamentId: number; trayIndex: number; inlet: FilamentTrackSwitchInlet }[] = []
  for (const [index, trayIndex] of amsMapping.entries()) {
    if (typeof trayIndex !== 'number' || !Number.isInteger(trayIndex) || trayIndex < 0) continue
    const inlet = inlets.get(trayIndex)
    if (!inlet) return null
    placements.push({ filamentId: index + 1, trayIndex, inlet })
  }
  if (placements.length === 0) return null

  // Group the MAPPED filaments only: a group id on a filament this plate does not print says
  // nothing about where a spool should go.
  const mappedFilamentIds = new Set(placements.map((placement) => placement.filamentId))
  const groups = new Map<number, Set<number>>()
  for (const [index, group] of optimalAssignment.entries()) {
    const filamentId = index + 1
    if (!mappedFilamentIds.has(filamentId)) continue
    const members = groups.get(group) ?? new Set<number>()
    members.add(filamentId)
    groups.set(group, members)
  }
  if (groups.size === 0 || groups.size > 2) return null

  const suggestedInletByFilamentId = groups.size === 1
    ? suggestOneGroup(placements)
    : suggestTwoGroups(placements, [...groups.values()])

  const moves: FilamentTrackSwitchMove[] = []
  for (const placement of placements) {
    const suggested = suggestedInletByFilamentId.get(placement.filamentId)
    if (!suggested || suggested === placement.inlet) continue
    moves.push({
      filamentId: placement.filamentId,
      trayIndex: placement.trayIndex,
      currentInlet: placement.inlet,
      suggestedInlet: suggested
    })
  }
  return { suggestedInletByFilamentId, moves }
}

/**
 * One group: put everything on whichever inlet already holds more of it.
 *
 * A tie resolves to A, matching Studio, and note the practical effect: with everything already on
 * one inlet the majority IS that inlet, so a correct single-group layout proposes no moves.
 */
function suggestOneGroup(
  placements: readonly { filamentId: number; inlet: FilamentTrackSwitchInlet }[]
): Map<number, FilamentTrackSwitchInlet> {
  const onA = placements.filter((placement) => placement.inlet === 'A').length
  const target: FilamentTrackSwitchInlet = onA >= placements.length - onA ? 'A' : 'B'
  return new Map(placements.map((placement) => [placement.filamentId, target] as const))
}

/**
 * Two groups: try both assignments and keep the one needing fewer moves.
 *
 * The score is literally "how many filaments are not already where this option puts them", which
 * is what makes the suggestion cheap to act on. Ties keep the first group on A, as Studio does
 * (`offset_1 <= offset_2`), so the answer is stable rather than flipping between equal options.
 */
function suggestTwoGroups(
  placements: readonly { filamentId: number; inlet: FilamentTrackSwitchInlet }[],
  groups: readonly Set<number>[]
): Map<number, FilamentTrackSwitchInlet> {
  const inletByFilamentId = new Map(placements.map((placement) => [placement.filamentId, placement.inlet] as const))
  const [first = new Set<number>(), second = new Set<number>()] = groups

  const cost = (firstInlet: FilamentTrackSwitchInlet): number => {
    const secondInlet: FilamentTrackSwitchInlet = firstInlet === 'A' ? 'B' : 'A'
    let moves = 0
    for (const filamentId of first) if (inletByFilamentId.get(filamentId) !== firstInlet) moves += 1
    for (const filamentId of second) if (inletByFilamentId.get(filamentId) !== secondInlet) moves += 1
    return moves
  }

  const firstInlet: FilamentTrackSwitchInlet = cost('A') <= cost('B') ? 'A' : 'B'
  const secondInlet: FilamentTrackSwitchInlet = firstInlet === 'A' ? 'B' : 'A'
  const suggested = new Map<number, FilamentTrackSwitchInlet>()
  for (const filamentId of first) suggested.set(filamentId, firstInlet)
  for (const filamentId of second) suggested.set(filamentId, secondInlet)
  return suggested
}

/** One move, as a sentence. `slotLabel` is injected because only the caller names slots. */
export function filamentTrackSwitchMoveSentence(move: FilamentTrackSwitchMove, slotLabel: string): string {
  return `Filament ${move.filamentId} is in ${slotLabel}, behind inlet ${move.currentInlet}.`
    + ` Moving it to an AMS on inlet ${move.suggestedInlet} would cut filament changes.`
}
