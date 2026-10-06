/**
 * Preflights a saved SVG artwork replacement before the editor mutates live parts or history.
 * A baked part may be removed only if printed geometry survives the entire replacement.
 */
import { isNonRenderableThreeMfPartSubtype, type SceneEditPartSubtype } from '@printstream/shared'
import { withRemovedParts, type EditorState, type SvgArtworkPart } from './editorModel'

type SvgReextrudePlan = {
  replace: ReadonlyArray<{ survivor: SvgArtworkPart }>
  add: ReadonlyArray<number>
  remove: ReadonlyArray<SvgArtworkPart>
}

interface SvgReextrudeSafety {
  removedBaked: Set<number>
  droppedAdded: Set<string>
  /** The baked-part removal, computed before any live mutation. Null means it was refused. */
  removedState: EditorState | null
  otherPrintedParts: number
  refused: boolean
}

/** Count the final added volumes, including subtype changes and newly staged pieces. */
export function prepareSvgReextrudeSafety(
  state: EditorState,
  hostId: number,
  subtype: SceneEditPartSubtype,
  plan: SvgReextrudePlan
): SvgReextrudeSafety {
  const removedBaked = new Set<number>()
  const droppedAdded = new Set<string>()
  const retypedAdded = new Set<string>()
  let newParts = plan.add.length

  for (const { survivor } of plan.replace) {
    if (survivor.kind === 'baked') {
      removedBaked.add(survivor.partIndex)
      newParts += 1
    } else {
      retypedAdded.add(survivor.key)
    }
  }
  for (const part of plan.remove) {
    if (part.kind === 'baked') removedBaked.add(part.partIndex)
    else droppedAdded.add(part.key)
  }

  const retainedPrinted = (state.addedParts?.[hostId] ?? []).filter((part) => {
    if (droppedAdded.has(part.key)) return false
    const finalSubtype = retypedAdded.has(part.key) ? subtype : part.subtype
    return !isNonRenderableThreeMfPartSubtype(finalSubtype)
  }).length
  const otherPrintedParts = retainedPrinted
    + (isNonRenderableThreeMfPartSubtype(subtype) ? 0 : newParts)
  const removedState = removedBaked.size > 0
    ? withRemovedParts(state, hostId, removedBaked, otherPrintedParts)
    : state

  return {
    removedBaked,
    droppedAdded,
    removedState,
    otherPrintedParts,
    refused: removedState === null
  }
}
