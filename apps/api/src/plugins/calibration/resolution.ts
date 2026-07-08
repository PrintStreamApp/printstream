/**
 * Pure resolution of which saved calibration value applies to a loaded filament.
 *
 * Priority (see the plugin design): a spool-specific result beats an identity
 * match, which beats nothing (leave the printer's own behavior alone). Among
 * identity matches, the most specific wins — the one constraining the most
 * fields — so "Polymaker PLA Pro Metallic Silver" is preferred over the broader
 * "Polymaker PLA Pro". Every non-null identity field on a result must equal the
 * spool's field; a null field is a wildcard.
 *
 * Callers pre-filter `candidates` to the relevant `kind` + printer model + nozzle
 * (the DB query does this); this module only decides scope/identity precedence,
 * so it stays trivially testable and free of Prisma.
 */
import type { CalibrationKind } from '@printstream/shared'

/** The filament a value could apply to: a spool id plus its identity fields. */
export interface CalibrationFilament {
  spoolId: string | null
  brand: string | null
  filamentType: string | null
  materialSubtype: string | null
  colorName: string | null
}

/** A stored result, reduced to the fields resolution needs. */
export interface ResolvableCalibrationResult {
  kind: CalibrationKind
  value: number
  scope: 'spool' | 'identity'
  spoolId: string | null
  brand: string | null
  filamentType: string | null
  materialSubtype: string | null
  colorName: string | null
}

const IDENTITY_FIELDS = ['brand', 'filamentType', 'materialSubtype', 'colorName'] as const

function identityMatches(result: ResolvableCalibrationResult, filament: CalibrationFilament): boolean {
  return IDENTITY_FIELDS.every((field) => result[field] == null || result[field] === filament[field])
}

/** Number of constrained (non-null) identity fields — higher is more specific. */
function specificity(result: ResolvableCalibrationResult): number {
  return IDENTITY_FIELDS.reduce((count, field) => count + (result[field] != null ? 1 : 0), 0)
}

/**
 * Pick the best value for `filament` among `candidates` (already filtered to one
 * kind + printer model + nozzle). Returns null when nothing applies, so the
 * caller can leave the printer's own calibration untouched.
 */
export function resolveCalibrationValue(
  candidates: ResolvableCalibrationResult[],
  filament: CalibrationFilament
): ResolvableCalibrationResult | null {
  if (filament.spoolId != null) {
    const spoolMatch = candidates.find((result) => result.scope === 'spool' && result.spoolId === filament.spoolId)
    if (spoolMatch) return spoolMatch
  }

  let best: ResolvableCalibrationResult | null = null
  let bestScore = -1
  for (const result of candidates) {
    if (result.scope !== 'identity' || !identityMatches(result, filament)) continue
    const score = specificity(result)
    if (score > bestScore) {
      best = result
      bestScore = score
    }
  }
  return best
}
