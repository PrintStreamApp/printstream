/**
 * Builds the text record, standalone mesh, and live added-part record for the editor's Text tool.
 *
 * Hosted text uses textPlacement.ts for geometry. Both paths record the resolved font face,
 * since the requested bold or italic cut may fall back to another face during loading.
 */
import type { Font } from 'opentype.js'
import { threeMfPartSubtypeCarriesFilament } from '@printstream/shared'
import { defaultTextInfo, type TextInfo } from '@printstream/shared/three-mf'
import type { EditorAddedPart } from './editorModel'
import { BUNDLED_FONTS, type TextFontFace } from './textFonts'
import { buildTextSoup } from './textGeometry'
import type { TextToolValue } from './textToolValue'

export interface TextSurfaceHit {
  point: { x: number; y: number; z: number }
  normal: { x: number; y: number; z: number }
}

/**
 * Serialize the form with the face actually used. A standalone object has no host surface;
 * only hosted text records a pointed face for BambuStudio's placement gizmo.
 */
export function textInfoForTool(
  value: TextToolValue,
  face: TextFontFace,
  options: { standalone: boolean; hit?: TextSurfaceHit | null }
): TextInfo {
  // Studio re-derives hosted placement from this raycast (`TextInfo::m_rr`). Omitting a
  // known hit makes its gizmo reopen pointing at the origin instead of the chosen surface.
  const hit = options.standalone ? null : options.hit
  return {
    ...defaultTextInfo(value.text, face.family),
    fontSize: value.fontSize,
    thickness: value.thickness,
    textGap: value.textGap,
    rotateAngle: value.rotateAngle,
    embeddedDepth: value.embeddedDepth,
    surfaceType: options.standalone ? 'horizontal' : value.surfaceMode,
    bold: value.bold,
    italic: value.italic,
    fontIndex: Math.max(0, BUNDLED_FONTS.findIndex((entry) => entry.id === face.id)),
    ...(hit ? {
      hitPosition: [hit.point.x, hit.point.y, hit.point.z] as [number, number, number],
      hitNormal: [hit.normal.x, hit.normal.y, hit.normal.z] as [number, number, number]
    } : {})
  }
}

/**
 * Make a standalone text object's soup rest on the bed. A hosted part stays centred around
 * its own origin instead, since textPlacement.ts seats that centre on the host surface.
 */
export function standaloneTextSoup(font: Font, value: TextToolValue): Float32Array {
  const soup = buildTextSoup(font, {
    text: value.text,
    fontSize: value.fontSize,
    thickness: value.thickness,
    textGap: value.textGap,
    rotateAngle: value.rotateAngle
  })
  if (soup.length === 0) return soup

  let minZ = Infinity
  for (let i = 2; i < soup.length; i += 3) minZ = Math.min(minZ, soup[i]!)
  for (let i = 2; i < soup.length; i += 3) soup[i] = soup[i]! - minZ
  return soup
}

type TextPartPlacement = Pick<EditorAddedPart, 'position' | 'rotation' | 'scale' | 'soup'>

/**
 * Rewrite a live text part with newly staged geometry. A pointer move supplies a complete new
 * placement from the same geometry answer, preventing a drag from swapping soup while keeping
 * an older transform. A form edit without a pointer keeps the part where the user left it.
 */
export function updateAddedTextPart(options: {
  part: EditorAddedPart
  importId: string
  placement: TextPartPlacement
  value: TextToolValue
  textInfo: TextInfo
  pointed: boolean
}): void {
  const { part, importId, placement, value, textInfo, pointed } = options
  part.importId = importId
  part.soup = placement.soup
  part.subtype = value.operation
  part.name = value.text.slice(0, 40)
  part.textInfo = textInfo
  if (pointed) {
    part.position.copy(placement.position)
    part.rotation.copy(placement.rotation)
    part.scale.copy(placement.scale)
  }
}

/** Create the first live part, retaining a saved baked part's placement when it is promoted. */
export function createAddedTextPart(options: {
  key: string
  importId: string
  placement: TextPartPlacement
  keptPlacement: Omit<TextPartPlacement, 'soup'> | null
  value: TextToolValue
  textInfo: TextInfo
  filamentId: number | null
}): EditorAddedPart {
  const { key, importId, placement, keptPlacement, value, textInfo, filamentId } = options
  return {
    key,
    importId,
    subtype: value.operation,
    name: value.text.slice(0, 40),
    ...(threeMfPartSubtypeCarriesFilament(value.operation) ? { filamentId } : {}),
    position: keptPlacement?.position ?? placement.position,
    rotation: keptPlacement?.rotation ?? placement.rotation,
    // The computed scale counters the host's scale, keeping text size in plate millimetres.
    scale: keptPlacement?.scale ?? placement.scale,
    soup: placement.soup,
    textInfo
  }
}
