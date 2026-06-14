const BAMBU_PRINTER_MODEL_ALIASES: Record<string, string[]> = {
  X1: ['X1'],
  X1C: ['X1C', 'X1 Carbon', 'C11'],
  X1E: ['X1E', 'X1E Enterprise', 'C13'],
  X2D: ['X2D', 'N6'],
  P1S: ['P1S'],
  P2S: ['P2S'],
  P1P: ['P1P'],
  A1: ['A1', 'A11', 'N1'],
  A1mini: ['A1 mini', 'A1mini', 'A1M', 'A12', 'A04', 'N2S'],
  A2L: ['A2L', 'N9'],
  H2D: ['H2D', 'O1D', 'BL-D001'],
  H2DPRO: ['H2D Pro', 'H2DPRO'],
  H2C: ['H2C', 'O1C', 'O1C2'],
  H2S: ['H2S']
}

export const KNOWN_BAMBU_PRINTER_MODEL_KEYS = Object.freeze(Object.keys(BAMBU_PRINTER_MODEL_ALIASES))

export function resolveBambuPrinterModelAliases(model: string): string[] {
  return BAMBU_PRINTER_MODEL_ALIASES[model] ?? [normalizeBambuStudioPrinterModelOption(model)]
}

export function normalizeBambuStudioPrinterModelOption(value: string): string {
  const trimmed = value.trim()
  const key = trimmed.toUpperCase()
  const mapped: Record<string, string> = {
    A04: 'A1 mini',
    A1M: 'A1 mini',
    A11: 'A1',
    A12: 'A1 mini',
    N1: 'A1',
    N2S: 'A1 mini',
    N9: 'A2L',
    C11: 'X1C',
    C13: 'X1E',
    N6: 'X2D',
    O1D: 'H2D',
    'BL-D001': 'H2D',
    O1C: 'H2C',
    O1C2: 'H2C'
  }
  return mapped[key] ?? trimmed.replace(/^Bambu\s+Lab\s+/i, '').replace(/\s+/g, ' ').trim()
}

/**
 * Resolves a printer name or model string to its canonical Bambu model key
 * (e.g. `H2D`, `H2DPRO`, `X1C`). Returns null for non-Bambu printers or values
 * that do not resolve to a known Bambu model. Order matters: more specific
 * variants (e.g. H2D Pro) are checked before their prefixes (H2D) so the two
 * stay distinct.
 */
export function canonicalBambuModelKey(value: unknown): string | null {
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : Array.isArray(value)
      ? String(value[0] ?? '').trim().toUpperCase()
      : ''

  if (!normalized || normalized === 'UNKNOWN') return null
  if (normalized.includes('H2D PRO') || normalized.includes('H2DPRO') || normalized.includes('H2DP')) return 'H2DPRO'
  if (normalized.includes('H2D')) return 'H2D'
  if (normalized.includes('H2C')) return 'H2C'
  if (normalized.includes('H2S')) return 'H2S'
  if (normalized.includes('X2D')) return 'X2D'
  if (normalized.includes('P2S')) return 'P2S'
  if (normalized.includes('X1E')) return 'X1E'
  if (normalized.includes('X1 CARBON') || normalized.includes('X1C')) return 'X1C'
  if (normalized.includes('P1S')) return 'P1S'
  if (normalized.includes('P1P')) return 'P1P'
  if (normalized.includes('A2L')) return 'A2L'
  if (normalized.includes('A1 MINI') || normalized.includes('A1M')) return 'A1MINI'
  if (normalized === 'A1' || normalized.includes(' A1 ')) return 'A1'
  return null
}

// Bambu groups the X1C-class 0.4mm machines as mutually process-compatible:
// BambuStudio's X1C process presets list X1 Carbon, X1, X1E, and P1S together,
// and PrintStream additionally treats P1P as part of this family.
const COMPATIBLE_BAMBU_MODEL_FAMILIES: readonly ReadonlySet<string>[] = [
  new Set(['X1', 'X1C', 'X1E', 'P1S', 'P1P'])
]

/**
 * Reports whether two canonical Bambu model keys are process-compatible. Two
 * keys are compatible when either side is unknown (non-Bambu or unresolved, so
 * we do not over-filter), when they are identical, or when they belong to the
 * same compatibility family. Distinct models that merely share a name prefix
 * (e.g. `H2D` and `H2DPRO`) are NOT compatible.
 */
export function bambuModelKeysAreCompatible(left: string | null, right: string | null): boolean {
  if (!left || !right) return true
  if (left === right) return true
  return COMPATIBLE_BAMBU_MODEL_FAMILIES.some((family) => family.has(left) && family.has(right))
}