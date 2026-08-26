/**
 * Fonts for the editor's Text tool: the bundled set, plus any file the user loads.
 *
 * The tool extrudes real glyph OUTLINES, which is why this fetches font FILES and parses them
 * rather than using the CSS webfonts the rest of the app renders with: a font loaded through CSS
 * exposes no outline data to script at all.
 *
 * The bundled faces are DejaVu subsets built by `scripts/dev/generate-text-tool-fonts.mjs` and
 * served from `public/`, so they cost nothing until the tool is opened. They deliberately cover
 * Latin-1 and common punctuation only; anything beyond that is what "load your own font" is for.
 *
 * Parsed fonts are cached for the session because parsing is pure work on bytes that never change,
 * and re-parsing on every keystroke of the text field would be absurd.
 */
import opentype, { type Font } from 'opentype.js'

export interface TextFontFace {
  /** Stable id, also what a saved `text_info.font_index` refers to within {@link BUNDLED_FONTS}. */
  id: string
  family: string
  /** Whether this face IS the bold/italic cut, as opposed to being synthesised. */
  bold: boolean
  italic: boolean
  /** Fetch path under `public/`, or absent for a face the user loaded from disk. */
  url?: string
}

/**
 * The bundled faces. Order is a persisted contract in a mild sense: `text_info.font_index` records
 * a position here, so append rather than reorder, or a saved project reopens claiming a different
 * face than it was made with.
 */
export const BUNDLED_FONTS: readonly TextFontFace[] = [
  { id: 'dejavu-sans', family: 'DejaVu Sans', bold: false, italic: false, url: '/fonts/text-tool/dejavu-sans.ttf' },
  { id: 'dejavu-sans-bold', family: 'DejaVu Sans', bold: true, italic: false, url: '/fonts/text-tool/dejavu-sans-bold.ttf' },
  { id: 'dejavu-serif', family: 'DejaVu Serif', bold: false, italic: false, url: '/fonts/text-tool/dejavu-serif.ttf' },
  { id: 'dejavu-serif-bold', family: 'DejaVu Serif', bold: true, italic: false, url: '/fonts/text-tool/dejavu-serif-bold.ttf' },
  { id: 'dejavu-mono', family: 'DejaVu Sans Mono', bold: false, italic: false, url: '/fonts/text-tool/dejavu-mono.ttf' },
  { id: 'dejavu-mono-bold', family: 'DejaVu Sans Mono', bold: true, italic: false, url: '/fonts/text-tool/dejavu-mono-bold.ttf' }
]

/** The families a user picks between; the bold/italic checkboxes then choose the cut. */
export const BUNDLED_FAMILIES: readonly string[] = [...new Set(BUNDLED_FONTS.map((face) => face.family))]

/**
 * The bundled face for a family and weight, falling back to the family's regular cut.
 *
 * There is no synthetic emboldening here: a real bold cut is drawn, not smeared, and faking one by
 * offsetting contours is what BambuStudio's `boldness` slider does to a face that HAS no bold cut.
 * Returning the regular face is honest, and the UI disables the checkbox to say so.
 */
export function bundledFace(family: string, bold: boolean, italic: boolean): TextFontFace | null {
  const inFamily = BUNDLED_FONTS.filter((face) => face.family === family)
  return inFamily.find((face) => face.bold === bold && face.italic === italic)
    ?? inFamily.find((face) => face.bold === bold)
    ?? inFamily.find((face) => !face.bold && !face.italic)
    ?? null
}

/** Whether a family ships the requested cut, so the UI can disable a checkbox that would do nothing. */
export function hasBundledCut(family: string, bold: boolean, italic: boolean): boolean {
  return BUNDLED_FONTS.some((face) => face.family === family && face.bold === bold && face.italic === italic)
}

const parsed = new Map<string, Font>()

/** Parse font bytes, throwing a message worth showing rather than opentype's internal one. */
function parseFont(bytes: ArrayBuffer, label: string): Font {
  try {
    return opentype.parse(bytes)
  } catch (error) {
    throw new Error(`${label} could not be read as a font file (${error instanceof Error ? error.message : 'unknown'}).`)
  }
}

/** Load and parse a bundled face, memoized for the session. */
export async function loadBundledFont(face: TextFontFace, signal?: AbortSignal): Promise<Font> {
  const cached = parsed.get(face.id)
  if (cached) return cached
  if (!face.url) throw new Error(`${face.family} has no bundled file.`)
  const response = await fetch(face.url, { signal })
  if (!response.ok) throw new Error(`Could not load ${face.family} (${response.status}).`)
  const font = parseFont(await response.arrayBuffer(), face.family)
  parsed.set(face.id, font)
  return font
}

/**
 * Register a font file the user picked from disk. Returns the face to select.
 *
 * The id is derived from the file name and size rather than being random, so re-loading the same
 * file in one session reuses the parse instead of accumulating duplicates in the picker.
 */
export async function loadUserFont(file: File): Promise<TextFontFace> {
  const id = `user:${file.name}:${file.size}`
  const bytes = await file.arrayBuffer()
  const font = parseFont(bytes, file.name)
  parsed.set(id, font)
  // 2.x groups names by platform; there is no top-level `names.fontFamily`.
  const family = font.names.windows?.fontFamily?.en
    ?? font.names.macintosh?.fontFamily?.en
    ?? font.names.unicode?.fontFamily?.en
    ?? file.name.replace(/\.[^.]+$/, '')
  return { id, family, bold: false, italic: false }
}

/** A face already parsed this session, bundled or user-loaded. */
export function parsedFont(id: string): Font | null {
  return parsed.get(id) ?? null
}
