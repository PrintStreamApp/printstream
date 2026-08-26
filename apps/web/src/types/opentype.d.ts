/**
 * Minimal typings for the parts of opentype.js 2.x the Text tool uses.
 *
 * Hand-written rather than pulled from `@types/opentype.js`, which is published for the 1.x API and
 * is wrong in exactly the place that already caused trouble here: 2.x moved `font.names` into
 * per-platform buckets (`names.windows.fontFamily`), so the 1.x `names.fontFamily` types a property
 * that is always undefined at runtime. Typing only what we call keeps that mismatch impossible.
 */
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'Q' | 'C' | 'Z'
    x?: number
    y?: number
    x1?: number
    y1?: number
    x2?: number
    y2?: number
  }

  export interface Path {
    commands: PathCommand[]
  }

  export interface Glyph {
    index: number
    advanceWidth?: number
    getPath(x: number, y: number, fontSize: number): Path
  }

  /** Localized name entries, keyed by language tag (`en`, ...). */
  export type LocalizedName = Record<string, string | undefined>

  export interface Font {
    unitsPerEm: number
    ascender: number
    descender: number
    /** 2.x groups names by platform; there is no top-level `fontFamily`. */
    names: {
      unicode?: { fontFamily?: LocalizedName; fontSubfamily?: LocalizedName }
      macintosh?: { fontFamily?: LocalizedName; fontSubfamily?: LocalizedName }
      windows?: { fontFamily?: LocalizedName; fontSubfamily?: LocalizedName }
    }
    charToGlyph(character: string): Glyph | undefined
    getKerningValue(left: number, right: number): number
  }

  export function parse(buffer: ArrayBuffer): Font

  const opentype: { parse: typeof parse }
  export default opentype
}
