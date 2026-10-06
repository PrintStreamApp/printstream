/**
 * Prepares one SVG commit before the editor stages geometry or records history.
 * The source artwork, archive identity, and BambuStudio shape record must describe
 * the same set of pieces. An excluded backdrop or a split cannot claim the whole SVG.
 */
import { studioShapeFixTransform, studioShapeScale, type BambuStudioShape, type SvgPartRecord } from '@printstream/shared/three-mf'
import { resolveSvgArchiveEntry, type EditorState } from './editorModel'
import {
  buildSvgPieceSoups,
  detectSvgBackgroundPiece,
  type ParsedSvg,
  type SvgPieceSoup
} from './svgGeometry'

/** Above this count, one merged volume keeps an illustration out of the object list. */
export const SVG_MAX_PARTS = 24

interface SvgArtworkSettings {
  widthMm: number
  thickness: number
  includeBackground: boolean
}

interface SvgArtworkInput {
  artwork: ParsedSvg
  settings: SvgArtworkSettings
  fileName: string | null
  markup: string | null
  state: EditorState | null
  archiveEntries: readonly string[]
  /** Reopening identical markup reuses its existing entry, even after a save. */
  reedit: { entryPath: string; loadedMarkup: string } | null
}

/** Concatenate already-centred triangle soups without changing their shared frame. */
function mergeSoups(soups: ReadonlyArray<Float32Array>): Float32Array {
  if (soups.length === 1) return soups[0]!
  const merged = new Float32Array(soups.reduce((total, soup) => total + soup.length, 0))
  let at = 0
  for (const soup of soups) {
    merged.set(soup, at)
    at += soup.length
  }
  return merged
}

/** Return null when background filtering leaves no shape to stage. */
export function prepareSvgArtwork({
  artwork,
  settings,
  fileName,
  markup,
  state,
  archiveEntries,
  reedit
}: SvgArtworkInput) {
  const backgroundIndex = detectSvgBackgroundPiece(artwork)
  const dropped = settings.includeBackground ? null : backgroundIndex
  // The piece's one-based source index survives filtering so part names retain paint order.
  const pieces = buildSvgPieceSoups(artwork, {
    widthMm: settings.widthMm,
    thickness: settings.thickness
  }).filter((piece) => dropped == null || piece.index !== dropped + 1)
  if (pieces.length === 0) return null

  const base = (fileName ?? 'Artwork').replace(/\.svg$/i, '').slice(0, 32) || 'Artwork'
  const split = pieces.length > 1 && pieces.length <= SVG_MAX_PARTS
  // Merge only survivors. Rebuilding from the source would silently restore a dropped backdrop.
  const soups: SvgPieceSoup[] = split
    ? pieces
    : [{ soup: mergeSoups(pieces.map((piece) => piece.soup)), index: 1, coverage: 1 }]
  const partName = (index: number) => (split ? `${base} ${index}` : base)

  const resolvedEntry = markup == null
    ? null
    : reedit && markup === reedit.loadedMarkup
      ? { entryPath: reedit.entryPath, reused: true }
      : resolveSvgArchiveEntry(state, fileName ?? 'artwork.svg', markup, archiveEntries)
  const entryPath = resolvedEntry?.entryPath ?? null
  const markupToStore = resolvedEntry && !resolvedEntry.reused ? markup : null

  /** Piece 0 denotes a merged import; split pieces retain their source indices. */
  const recordFor = (pieceIndex: number): SvgPartRecord | null => (entryPath == null ? null : {
    entryPath,
    fileName: fileName ?? 'artwork.svg',
    pieceIndex: split ? pieceIndex : 0,
    widthMm: settings.widthMm,
    thickness: settings.thickness,
    includeBackground: settings.includeBackground
  })

  // Studio re-parses this record as the WHOLE artwork. A split or excluded backdrop
  // makes that claim false and must not carry the record on save.
  const wholeArtwork = !split && dropped == null
  const bambuShapeFor = (): BambuStudioShape | null => (entryPath == null || !wholeArtwork ? null : {
    filePath: fileName ?? 'artwork.svg',
    filePathIn3mf: entryPath,
    scale: studioShapeScale(settings.widthMm / (artwork.width || 1)),
    unhealed: false,
    depth: settings.thickness,
    useSurface: false,
    fixTransform: studioShapeFixTransform(settings.thickness)
  })

  return { soups, split, entryPath, markupToStore, partName, recordFor, bambuShapeFor }
}
