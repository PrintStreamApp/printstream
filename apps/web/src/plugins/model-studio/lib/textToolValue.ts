/**
 * The Text tool's panel value: what the user has described, independent of how it is realised.
 *
 * Its own module rather than living beside the panel component, because both the panel and the
 * editor need it and a component file that also exports constants and helpers breaks fast refresh.
 */
import type { SceneEditPartSubtype } from '@printstream/shared'
import type { TextInfo } from '@printstream/shared/three-mf'
import { BUNDLED_FONTS } from './textFonts'
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

/**
 * Re-open a saved text part in the panel, from the `<text_info>` it carries.
 *
 * The font FAMILY is the one field that can fail to resolve: a file may name a font this install
 * does not bundle and the user never loaded. Falling back to the current family keeps the text
 * editable rather than refusing to open it, at the cost of re-rendering it in a different face --
 * which the user can see and change, unlike a dialog that will not open.
 */
export function textToolValueFromInfo(
  info: TextInfo,
  subtype: SceneEditPartSubtype,
  fallback: TextToolValue
): TextToolValue {
  const known = BUNDLED_FONTS.some((face) => face.family === info.fontName)
  return {
    text: info.text,
    family: known ? info.fontName : fallback.family,
    bold: info.bold,
    italic: info.italic,
    fontSize: info.fontSize,
    thickness: info.thickness,
    textGap: info.textGap,
    rotateAngle: info.rotateAngle,
    embeddedDepth: info.embeddedDepth,
    // `surfaceChar` is not offered (see the tool's development notes), but a file -- ours from before it was
    // withdrawn, or one Studio wrote -- can name it. Coerced to the mode it now behaves as, so the
    // picker shows what the text will actually do rather than blanking on a value it has no option
    // for. The record itself keeps whatever it said; only the panel is coerced.
    surfaceMode: info.surfaceType === 'surfaceChar' ? 'surface' : info.surfaceType,
    operation: subtype
  }
}
