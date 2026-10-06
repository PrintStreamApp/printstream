/**
 * Prepares the Cut tool's kept halves before staging any imports or mutating editor history.
 * The viewport supplies the world-space soup and live panel values; this module owns the
 * geometry and safety checks so the commit path receives only valid kept pieces.
 */
import { CUT_AXIS_SIDES } from '../editorGeometry'
import { isClosedSoup } from './meshBooleanCore'
import {
  cutTriangleSoup,
  cutTriangleSoupWithGroove,
  type CutAxis,
  type CutHalfOrientation,
  type CutMode,
  type GrooveCut
} from './meshCut'
import type { CutHalfToStage } from './editorCutStaging'

interface CutPreparationInput {
  soup: Float32Array
  mode: CutMode
  axis: CutAxis
  offset: number
  groove: GrooveCut
  keepLower: boolean
  keepUpper: boolean
  orientLower: CutHalfOrientation
  orientUpper: CutHalfOrientation
  connectorCount: number
  connectorProblem: string | null
}

type CutPreparationResult =
  | { halves: CutHalfToStage[]; error: null }
  | { halves: null; error: string }

/** Return kept halves in lower/upper order, or the reason a cut cannot be committed. */
export function prepareEditorCut(input: CutPreparationInput): CutPreparationResult {
  const { upper, lower } = input.mode === 'dovetail'
    ? cutTriangleSoupWithGroove(input.soup, input.axis, input.offset, input.groove)
    : cutTriangleSoup(input.soup, input.axis, input.offset)

  // Groove cuts can leave a boundary at otherwise valid panel settings. Plane cuts have their
  // own capping tests and do not need this extra mesh walk on every click.
  if (input.mode === 'dovetail' && (
    (upper.length > 0 && !isClosedSoup(upper))
    || (lower.length > 0 && !isClosedSoup(lower))
  )) {
    return { halves: null, error: 'That groove leaves an open edge on this model. Try a different depth, width or axis.' }
  }

  const sides = CUT_AXIS_SIDES[input.axis]
  const halves: CutHalfToStage[] = []
  if (input.keepLower && lower.length > 0) {
    halves.push({ soup: lower, suffix: sides.lower, side: 'lower', orientation: input.orientLower })
  }
  if (input.keepUpper && upper.length > 0) {
    halves.push({ soup: upper, suffix: sides.upper, side: 'upper', orientation: input.orientUpper })
  }
  if (halves.length === 0) {
    return { halves: null, error: 'Nothing to keep: move the cut plane or keep at least one side.' }
  }

  // A connector needs a hole and a peg, so keeping one side must fail before staging either.
  if (input.connectorProblem) {
    return { halves: null, error: `Invalid connectors: ${input.connectorProblem}.` }
  }
  if (input.connectorCount > 0 && halves.length < 2) {
    return { halves: null, error: 'Connectors need both halves kept.' }
  }

  return { halves, error: null }
}
