/**
 * The Text tool's panel value: what the user has described, independent of how it is realised.
 *
 * Its own module rather than living beside the panel component, because both the panel and the
 * editor need it and a component file that also exports constants and helpers breaks fast refresh.
 */
import type { SceneEditPartSubtype } from '@printstream/shared'
import type { TextSurfaceType } from '@printstream/shared/three-mf'

export interface TextToolValue {
  text: string
  family: string
  bold: boolean
  italic: boolean
  fontSize: number
  thickness: number
  textGap: number
  rotateAngle: number
  /** How far the text sinks INTO the surface, mm. Studio's `embeded_depth`. Join only. */
  embeddedDepth: number
  surfaceMode: TextSurfaceType
  operation: SceneEditPartSubtype
}

/**
 * What a fresh session starts with, as BambuStudio does rather than an empty field.
 *
 * An empty field builds nothing, so the tool would open describing text the user cannot see; a
 * default means there is something on the model to look at and drag from the moment it opens,
 * which is the whole premise of create-then-edit.
 */
export const DEFAULT_TEXT = 'Text'

/**
 * Are two panel values the same text, described the same way?
 *
 * Used to tell a LOAD from an EDIT: the live-rebuild effect cannot otherwise distinguish the panel
 * being populated from a saved record (which must not move the text) from the user changing
 * something (which must).
 */
export function textToolValuesEqual(a: TextToolValue, b: TextToolValue): boolean {
  return a.text === b.text && a.family === b.family && a.bold === b.bold && a.italic === b.italic
    && a.fontSize === b.fontSize && a.thickness === b.thickness && a.textGap === b.textGap
    && a.rotateAngle === b.rotateAngle && a.embeddedDepth === b.embeddedDepth
    && a.surfaceMode === b.surfaceMode && a.operation === b.operation
}
