/**
 * BambuStudio's `<text_info>` sidecar: what a text part was MADE from, so it stays editable.
 *
 * A text part's geometry is baked triangles like any other, and without this record a typo means
 * deleting the part and rebuilding it — in our editor and in BambuStudio alike. Studio writes one
 * `<text_info/>` per part inside `Metadata/model_settings.config`, and this module is the only
 * place that speaks that format. Writer `bbs_3mf.cpp:7892`, reader `:4859`.
 *
 * **The attribute names are Studio's, typo included.** `embeded_depth` is spelled that way in the
 * file; correcting it silently drops the value on both sides.
 *
 * **`fontVersion` is not decoration, it gates two attributes, and the gates are ASYMMETRIC.**
 * Studio's writer emits the modern `surface_type` only at version >= 2.0, falling back to the
 * legacy `surface_text` + `keep_horizontal` pair below that; but its READER only accepts
 * `boldness`/`skew` above 2.2. A file written at, say, 2.0 therefore round-trips its surface mode
 * and silently loses its boldness. {@link TEXT_INFO_FONT_VERSION} sits above both gates for that
 * reason — do not lower it.
 */

import {
  decodeXmlAttributeValue,
  escapeXmlAttribute,
  xmlAttribute as attribute,
  xmlNumberAttribute as numberAttribute
} from './xml-write.js'

/** Studio's `TextInfo::TextType` (`Model.hpp:857`). */
export const TEXT_SURFACE_TYPES = ['horizontal', 'surface', 'surfaceHorizontal', 'surfaceChar'] as const
export type TextSurfaceType = (typeof TEXT_SURFACE_TYPES)[number]

/**
 * What we stamp as `font_version`. Above BOTH of Studio's gates (>= 2.0 so `surface_type` is
 * written, > 2.2 so its reader takes `boldness`/`skew`), so everything we write survives a
 * round-trip through Studio.
 */
export const TEXT_INFO_FONT_VERSION = '2.3'

/** Studio's own defaults (`Model.hpp:847`+). `bold` really does default to true. */
export const TEXT_INFO_DEFAULTS = {
  fontSize: 10,
  thickness: 2,
  embeddedDepth: 0,
  rotateAngle: 0,
  textGap: 0,
  bold: true,
  italic: false,
  boldness: 0,
  skew: 0
} as const

/** Studio's UI limits for the numeric fields. */
export const TEXT_INFO_LIMITS = {
  fontSize: { min: 3, max: 1000 },
  thickness: { min: 0.1, max: 1000 },
  embeddedDepth: { min: 0, max: 1000 },
  textGap: { min: -10, max: 100 },
  rotateAngle: { min: -180, max: 180 }
} as const

export interface TextInfo {
  text: string
  fontName: string
  /** Style name within the family, e.g. "Bold Italic". Studio's `style_name`. */
  styleName: string
  fontIndex: number
  fontSize: number
  thickness: number
  /** How far the text sinks INTO its host, mm. Studio spells the attribute `embeded_depth`. */
  embeddedDepth: number
  rotateAngle: number
  textGap: number
  bold: boolean
  italic: boolean
  boldness: number
  skew: number
  surfaceType: TextSurfaceType
  /** The raycast that placed surface text: which mesh was hit, where, and its normal. */
  hitMeshId: number
  hitPosition: readonly [number, number, number]
  hitNormal: readonly [number, number, number]
}

/**
 * Studio's default is SURFACE, not horizontal.
 *
 * Its enum comments `HORIZONAL = 0, // Default`, but the member initialiser three lines below is
 * `m_surface_type = 1` and `GLGizmoText::reset_text_info` sets `TextType::SURFACE` outright
 * (`Model.hpp:857`, `GLGizmoText.cpp:3061`). The comment is wrong; writing `horizontal` here made
 * every file we saved declare a mode Studio would not have chosen.
 */
export const TEXT_INFO_DEFAULT_SURFACE_TYPE: TextSurfaceType = 'surface'

export function defaultTextInfo(text: string, fontName: string): TextInfo {
  return {
    text,
    fontName,
    styleName: '',
    fontIndex: 0,
    ...TEXT_INFO_DEFAULTS,
    surfaceType: TEXT_INFO_DEFAULT_SURFACE_TYPE,
    hitMeshId: 0,
    hitPosition: [0, 0, 0],
    hitNormal: [0, 0, 1]
  }
}

/**
 * Serialize one `<text_info/>` element, exactly as Studio writes it.
 *
 * Emitted with `surface_type` rather than the legacy pair because {@link TEXT_INFO_FONT_VERSION}
 * is above Studio's 2.0 gate; a caller cannot choose otherwise, since writing the legacy pair at a
 * modern version would produce a file Studio itself reads inconsistently.
 */
export function serializeTextInfo(info: TextInfo): string {
  const vec = (v: readonly [number, number, number]): string => v.map((n) => `${n}`).join(' ')
  const attributes: Array<[string, string]> = [
    ['text', escapeXmlAttribute(info.text)],
    ['font_name', escapeXmlAttribute(info.fontName)],
    ['font_version', TEXT_INFO_FONT_VERSION],
    ['style_name', escapeXmlAttribute(info.styleName)],
    ['boldness', `${info.boldness}`],
    ['skew', `${info.skew}`],
    ['font_index', `${info.fontIndex}`],
    ['font_size', `${info.fontSize}`],
    ['thickness', `${info.thickness}`],
    ['embeded_depth', `${info.embeddedDepth}`],
    ['rotate_angle', `${info.rotateAngle}`],
    ['text_gap', `${info.textGap}`],
    ['bold', info.bold ? '1' : '0'],
    ['italic', info.italic ? '1' : '0'],
    ['surface_type', `${TEXT_SURFACE_TYPES.indexOf(info.surfaceType)}`],
    ['hit_mesh', `${info.hitMeshId}`],
    ['hit_position', vec(info.hitPosition)],
    ['hit_normal', vec(info.hitNormal)]
  ]
  return `<text_info ${attributes.map(([key, value]) => `${key}="${value}"`).join(' ')}/>`
}

function vectorAttribute(source: string, name: string, fallback: readonly [number, number, number]):
[number, number, number] {
  const raw = attribute(source, name)
  if (raw == null) return [...fallback]
  const parts = raw.trim().split(/\s+/).map((n) => Number.parseFloat(n))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return [...fallback]
  return [parts[0]!, parts[1]!, parts[2]!]
}

/**
 * Parse one `<text_info/>` element. Returns null when the element carries no `text`, which is the
 * only field with no sensible default: a text part with no text is not editable text.
 *
 * Accepts BOTH surface encodings, because a file written by an older Studio carries the legacy
 * `surface_text` + `keep_horizontal` pair and nothing rewrites it. The mapping is Studio's own
 * (`bbs_3mf.cpp:4900`), including its quirk that `keep_horizontal` alone and neither flag both mean
 * plain horizontal.
 */
export function parseTextInfo(source: string): TextInfo | null {
  const text = attribute(source, 'text')
  if (text == null) return null

  const rawSurfaceType = attribute(source, 'surface_type')
  let surfaceType: TextSurfaceType
  if (rawSurfaceType != null) {
    surfaceType = TEXT_SURFACE_TYPES[Number.parseInt(rawSurfaceType, 10)] ?? 'horizontal'
  } else {
    const isSurface = numberAttribute(source, 'surface_text', 0) !== 0
    const keepHorizontal = numberAttribute(source, 'keep_horizontal', 0) !== 0
    surfaceType = isSurface ? (keepHorizontal ? 'surfaceHorizontal' : 'surface') : 'horizontal'
  }

  // Studio reads these only above font_version 2.2 and leaves them unset otherwise, so a file
  // below that gate has no meaningful values here whatever the attributes happen to say.
  const version = Number.parseFloat(attribute(source, 'font_version') ?? '0')
  const styled = Number.isFinite(version) && version > 2.2

  return {
    text: decodeXmlAttributeValue(text),
    fontName: decodeXmlAttributeValue(attribute(source, 'font_name') ?? ''),
    styleName: decodeXmlAttributeValue(attribute(source, 'style_name') ?? ''),
    fontIndex: Math.trunc(numberAttribute(source, 'font_index', 0)),
    fontSize: numberAttribute(source, 'font_size', TEXT_INFO_DEFAULTS.fontSize),
    thickness: numberAttribute(source, 'thickness', TEXT_INFO_DEFAULTS.thickness),
    embeddedDepth: numberAttribute(source, 'embeded_depth', TEXT_INFO_DEFAULTS.embeddedDepth),
    rotateAngle: numberAttribute(source, 'rotate_angle', TEXT_INFO_DEFAULTS.rotateAngle),
    textGap: numberAttribute(source, 'text_gap', TEXT_INFO_DEFAULTS.textGap),
    bold: numberAttribute(source, 'bold', TEXT_INFO_DEFAULTS.bold ? 1 : 0) !== 0,
    italic: numberAttribute(source, 'italic', 0) !== 0,
    boldness: styled ? numberAttribute(source, 'boldness', TEXT_INFO_DEFAULTS.boldness) : TEXT_INFO_DEFAULTS.boldness,
    skew: styled ? numberAttribute(source, 'skew', TEXT_INFO_DEFAULTS.skew) : TEXT_INFO_DEFAULTS.skew,
    surfaceType,
    hitMeshId: Math.trunc(numberAttribute(source, 'hit_mesh', 0)),
    hitPosition: vectorAttribute(source, 'hit_position', [0, 0, 0]),
    hitNormal: vectorAttribute(source, 'hit_normal', [0, 0, 1])
  }
}
