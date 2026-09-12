/**
 * Assigns project filaments to the two nozzles of a multi-toolhead printer.
 *
 * The solver owns only grouping: callers resolve Bambu profile compatibility and provide the
 * project's directed flushing matrix. Fewer than ten filaments are searched exhaustively; larger
 * sets use a deterministic PAM-style local search bounded to 500 ms so opening the dialog cannot
 * stall the UI. Every candidate is checked against the profile's printable mask before scoring.
 */

export type FilamentGroupingMode = 'saving' | 'match' | 'quality'

export interface FilamentGroupingItem {
  id: number
  compatibleToolheadIds: readonly string[]
  /** Nozzle currently feeding a matching loaded spool, when the printer reports one. */
  loadedToolheadId?: string | null
  /** Lower is better. Used by Quality mode when the nozzles have different variants. */
  qualityPenaltyByToolheadId?: Readonly<Record<string, number>>
}

export interface FilamentGroupingInput {
  mode: FilamentGroupingMode
  toolheadIds: readonly [string, string]
  filaments: readonly FilamentGroupingItem[]
  /** Directed flushing volumes indexed in the same order as `filaments`. */
  flushVolumes?: readonly (readonly number[])[] | null
}

export interface FilamentGroupingResult {
  assignments: Record<number, string>
  flushCost: number
  movedCount: number
  qualityPenalty: number
  exhaustive: boolean
}

interface Candidate extends Omit<FilamentGroupingResult, 'assignments' | 'exhaustive'> {
  sides: number[]
}

/** Find the best valid two-nozzle assignment for the requested grouping strategy. */
export function solveFilamentGrouping(input: FilamentGroupingInput): FilamentGroupingResult | null {
  const { filaments, toolheadIds } = input
  if (filaments.length === 0) {
    return null
  }

  const allowed = filaments.map((filament) => {
    return toolheadIds.map((id) => filament.compatibleToolheadIds.includes(id))
  })
  if (allowed.some((row) => !row[0] && !row[1])) {
    return null
  }

  let best: Candidate | null = null
  const consider = (sides: number[], currentBest: Candidate | null): Candidate | null => {
    if (sides.some((side, index) => !allowed[index]?.[side])) {
      return currentBest
    }

    const candidate = scoreCandidate(input, sides)
    if (!currentBest || compareCandidates(input.mode, candidate, currentBest) < 0) {
      return candidate
    }

    return currentBest
  }

  const exhaustive = filaments.length < 10
  if (exhaustive) {
    const count = 2 ** filaments.length
    for (let mask = 0; mask < count; mask += 1) {
      const sides = filaments.map((_filament, index) => (mask >> index) & 1)
      best = consider(sides, best)
    }
  } else {
    // Seed from the live arrangement when possible, then improve it by one-medoid moves. Several
    // deterministic alternate seeds avoid getting trapped in the first local minimum.
    const seeds = [
      filaments.map((filament, index) => {
        const loaded = filament.loadedToolheadId ? toolheadIds.indexOf(filament.loadedToolheadId) : -1
        if (loaded >= 0 && allowed[index]?.[loaded]) {
          return loaded
        }

        return chooseSeedSide(allowed[index], index % 2)
      }),
      filaments.map((_filament, index) => chooseSeedSide(allowed[index], index % 2)),
      filaments.map((_filament, index) => chooseSeedSide(allowed[index], (index + 1) % 2))
    ]
    const deadline = Date.now() + 500

    for (const seed of seeds) {
      let current = [...seed]
      let improving = true

      while (improving && Date.now() < deadline) {
        improving = false
        const currentScore = scoreCandidate(input, current)

        for (let index = 0; index < current.length; index += 1) {
          const nextSide = 1 - current[index]!
          if (!allowed[index]?.[nextSide]) {
            continue
          }

          const trial = current.map((side, candidate) => (
            candidate === index ? nextSide : side
          ))
          const trialScore = scoreCandidate(input, trial)

          if (compareCandidates(input.mode, trialScore, currentScore) < 0) {
            current = trial
            improving = true
            break
          }
        }
      }
      best = consider(current, best)
    }
  }

  if (!best) {
    return null
  }

  const assignments = Object.fromEntries(filaments.map((filament, index) => {
    return [filament.id, toolheadIds[best.sides[index]!]!]
  }))

  return {
    assignments,
    flushCost: best.flushCost,
    movedCount: best.movedCount,
    qualityPenalty: best.qualityPenalty,
    exhaustive
  }
}

/** Choose a valid deterministic side for a heuristic seed. */
function chooseSeedSide(allowed: readonly boolean[] | undefined, preferred: number): number {
  if (allowed?.[preferred]) {
    return preferred
  }

  return allowed?.[0] ? 0 : 1
}

/** Score one valid assignment in units shared by all three automatic strategies. */
function scoreCandidate(input: FilamentGroupingInput, sides: number[]): Candidate {
  let flushCost = 0

  for (let from = 0; from < sides.length; from += 1) {
    for (let to = 0; to < sides.length; to += 1) {
      const changesWithinToolhead = from !== to && sides[from] === sides[to]
      if (changesWithinToolhead) {
        flushCost += finiteCost(input.flushVolumes?.[from]?.[to])
      }
    }
  }

  let movedCount = 0
  let qualityPenalty = 0

  input.filaments.forEach((filament, index) => {
    const toolheadId = input.toolheadIds[sides[index]!]!
    if (filament.loadedToolheadId && filament.loadedToolheadId !== toolheadId) {
      movedCount += 1
    }

    qualityPenalty += finiteCost(filament.qualityPenaltyByToolheadId?.[toolheadId])
  })

  return { sides, flushCost, movedCount, qualityPenalty }
}

/** Compare candidates lexicographically in the priority order promised by the selected mode. */
function compareCandidates(mode: FilamentGroupingMode, left: Candidate, right: Candidate): number {
  const leftScore = candidateScoreForMode(mode, left)
  const rightScore = candidateScoreForMode(mode, right)

  for (let index = 0; index < leftScore.length; index += 1) {
    const difference = leftScore[index]! - rightScore[index]!
    if (difference !== 0) {
      return difference
    }
  }

  // Stable tie-break independent of object key ordering.
  return left.sides.join('').localeCompare(right.sides.join(''))
}

/** Convert a candidate into the lexicographic score tuple for one user-facing strategy. */
function candidateScoreForMode(mode: FilamentGroupingMode, candidate: Candidate): number[] {
  if (mode === 'match') {
    return [candidate.movedCount, candidate.flushCost, candidate.qualityPenalty]
  }

  if (mode === 'quality') {
    return [candidate.qualityPenalty, candidate.flushCost, candidate.movedCount]
  }

  return [candidate.flushCost, candidate.movedCount, candidate.qualityPenalty]
}

/** Converts an absent or invalid cost to the solver's non-negative numeric domain. */
function finiteCost(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Decode Bambu's `filament_printable` bitmask for a slicer-extruder position. The bit is NOT a
 * runtime nozzle id: an H2D commonly declares `physical_extruder_map = [1, 0]`, so bit zero is the
 * left nozzle even though its runtime id is 1. The default value 3 permits both extruders.
 */
export function filamentPrintableOnExtruder(value: unknown, extruderIndex: number): boolean {
  const entry = Array.isArray(value) ? value[0] : value
  const mask = Number.parseInt(String(entry ?? '3'), 10)
  return !Number.isFinite(mask) || (mask & (1 << extruderIndex)) !== 0
}
