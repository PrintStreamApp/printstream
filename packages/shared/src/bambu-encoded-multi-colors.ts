/**
 * Multi-color Bambu filament entries from BambuStudio's
 * `filaments_color_codes.json` catalog.
 *
 * Single-color entries are handled by `bambu-colors.ts`; this dataset only
 * covers palettes with multiple colors so the UI can resolve names like
 * "Arctic Whisper" and paint gradient slot badges.
 */
import { normalizeHexColor } from './print-queue.js'

export interface BambuEncodedMultiColor {
  trayInfoIdx: string
  material: string
  name: string
  colors: string[]
  trayCodeAliases?: string[]
}

export const BAMBU_ENCODED_MULTI_COLORS: BambuEncodedMultiColor[] = [
  { trayInfoIdx: 'GFA00', material: 'PLA Basic', name: 'Arctic Whisper', colors: ['#FFFFFF', '#9CDBD9'], trayCodeAliases: ['A00-G0'] },
  { trayInfoIdx: 'GFA00', material: 'PLA Basic', name: 'Solar Breeze', colors: ['#E94B3C', '#FFFFFF'], trayCodeAliases: ['A00-G1'] },
  { trayInfoIdx: 'GFA00', material: 'PLA Basic', name: 'Ocean to Meadow', colors: ['#307FE2', '#54FF9B'], trayCodeAliases: ['A00-G2'] },
  { trayInfoIdx: 'GFA00', material: 'PLA Basic', name: 'Pink Citrus', colors: ['#F78F77', '#E4505A'], trayCodeAliases: ['A00-G3'] },
  { trayInfoIdx: 'GFA00', material: 'PLA Basic', name: 'Mint Lime', colors: ['#4EC939', '#B6FF43'], trayCodeAliases: ['A00-G4'] },
  { trayInfoIdx: 'GFA00', material: 'PLA Basic', name: 'Blueberry Bubblegum', colors: ['#6FCAEF', '#8573DD'], trayCodeAliases: ['A00-G5'] },
  { trayInfoIdx: 'GFA00', material: 'PLA Basic', name: 'Dusk Glare', colors: ['#CE4406', '#ED9558'], trayCodeAliases: ['A00-G6'] },
  { trayInfoIdx: 'GFA00', material: 'PLA Basic', name: 'Cotton Candy Cloud', colors: ['#8EC9E9', '#E7C1D5'], trayCodeAliases: ['A00-G7'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'Gilded Rose', colors: ['#FF9425', '#C16784'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'Midnight Blaze', colors: ['#0047BB', '#7D1B49'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'Neon City', colors: ['#BB22A3', '#0047BB'], trayCodeAliases: ['A05-T3'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'Blue Hawaii', colors: ['#70C884', '#418FDE'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'Velvet Eclipse (Black-Red)', colors: ['#000000', '#A34342'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'South Beach', colors: ['#00918B', '#F772A4'], trayCodeAliases: ['A05-M1'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'Aurora Purple', colors: ['#7F3696', '#006EC9'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'Dawn Radiance', colors: ['#EC984C', '#6CD4BC', '#A66EB9', '#D87694'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'Mystic Magenta', colors: ['#720062', '#3A913F'] },
  { trayInfoIdx: 'GFA05', material: 'PLA Silk', name: 'Phantom Blue', colors: ['#000000', '#00629B'] },
  { trayInfoIdx: 'GFU03', material: 'TPU 90A', name: 'Frozen', colors: ['#FFFFFF', '#40B6E4'] },
  { trayInfoIdx: 'GFU03', material: 'TPU 90A', name: 'Blaze', colors: ['#D21B3C', '#F1AAA8'] }
]

function paletteKey(colors: readonly string[]): string {
  return colors.join('|')
}

const COLOR_LOOKUP = new Map(
  BAMBU_ENCODED_MULTI_COLORS.map((entry) => [`${entry.trayInfoIdx}|${paletteKey(entry.colors)}`, entry] as const)
)

const ALIAS_LOOKUP = new Map(
  BAMBU_ENCODED_MULTI_COLORS.flatMap((entry) =>
    (entry.trayCodeAliases ?? []).map((alias) => [`${entry.trayInfoIdx}|${alias.toUpperCase()}`, entry] as const)
  )
)

export function findBambuEncodedMultiColor(
  trayInfoIdx: string | null | undefined,
  colors: readonly string[] | null | undefined
): BambuEncodedMultiColor | null {
  const normalizedTrayInfoIdx = trayInfoIdx?.trim().toUpperCase() ?? ''
  if (!normalizedTrayInfoIdx) return null

  const palette = (colors ?? [])
    .map((entry) => normalizeHexColor(entry))
    .filter((entry): entry is string => entry != null)

  if (palette.length < 2) return null
  return COLOR_LOOKUP.get(`${normalizedTrayInfoIdx}|${paletteKey(palette)}`) ?? null
}

export function findBambuEncodedMultiColorAlias(
  trayInfoIdx: string | null | undefined,
  trayName: string | null | undefined
): BambuEncodedMultiColor | null {
  const normalizedTrayInfoIdx = trayInfoIdx?.trim().toUpperCase() ?? ''
  const normalizedTrayName = trayName?.trim().toUpperCase() ?? ''
  if (!normalizedTrayInfoIdx || !normalizedTrayName) return null
  return ALIAS_LOOKUP.get(`${normalizedTrayInfoIdx}|${normalizedTrayName}`) ?? null
}