/**
 * Finds Text and SVG authoring records in the editor's two part stores. Session-added parts live
 * under a host object id; baked parts live on plate instances and retain a stable part ordinal.
 * The tool opener needs these identities to re-edit instead of placing duplicate artwork.
 */
import {
  addedPartHostId,
  type EditorAddedPart,
  type EditorInstance,
  type EditorInstancePart,
  type EditorPlate,
  type EditorState
} from './editorModel'

export interface BakedAuthoredPart {
  part: EditorInstancePart
  instance: EditorInstance
  hostId: number
  partIndex: number
}

/** Find a session part by its client key, retaining the host id stored in `addedParts`. */
function findSessionPart(
  state: EditorState | null,
  key: string,
  authored: (part: EditorAddedPart) => boolean
): { part: EditorAddedPart; hostId: number } | null {
  for (const [hostId, parts] of Object.entries(state?.addedParts ?? {})) {
    const part = parts.find((entry) => entry.key === key && authored(entry))
    if (part) return { part, hostId: Number(hostId) }
  }
  return null
}

/** A Text part must resolve to a live host instance; the panel addresses that instance by key. */
export function findEditorAddedTextPart(
  state: EditorState | null,
  plate: EditorPlate | null | undefined,
  key: string
): { part: EditorAddedPart; hostInstanceKey: string } | null {
  const match = findSessionPart(state, key, (part) => part.textInfo != null)
  if (!match) return null
  const instance = plate?.instances.find((entry) => addedPartHostId(entry) === match.hostId)
  return instance ? { part: match.part, hostInstanceKey: instance.key } : null
}

/** SVG's archive record and host object id are sufficient to reopen its artwork. */
export function findEditorAddedSvgPart(
  state: EditorState | null,
  key: string
): { part: EditorAddedPart; hostId: number } | null {
  return findSessionPart(state, key, (part) => part.svgPart != null)
}

/** A baked authored part is addressed by part ordinal, never by its position in a filtered list. */
export function findEditorBakedAuthoredPart(
  plate: EditorPlate | null | undefined,
  objectId: number,
  partIndex: number
): BakedAuthoredPart | null {
  for (const instance of plate?.instances ?? []) {
    if (addedPartHostId(instance) !== objectId) continue
    const part = instance.parts.find((entry) => entry.partIndex === partIndex)
    if (!part) continue
    if (!part.textInfo && !part.svgPart) return null
    return { part, instance, hostId: objectId, partIndex }
  }
  return null
}
