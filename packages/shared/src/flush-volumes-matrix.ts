/**
 * The `flush_volumes_matrix` sizing invariant for Bambu `project_settings.config`.
 *
 * OWNS: deciding whether a project's flush matrix matches its machine topology, and rebuilding it
 * when it does not. Pure string/array work — the callers own their own ZIP/HTTP I/O.
 *
 * CONTRACT. BambuStudio stores the matrix as `extruder_count` CONSECUTIVE BLOCKS, each a
 * `filament_count x filament_count` row-major matrix (`PrintConfig.hpp`
 * `get_flush_volumes_matrix`/`set_flush_volumes_matrix` slice block `e` as
 * `[size/nozzles*e, size/nozzles*(e+1))`; `BambuStudio.cpp` sizes it
 * `project_filament_count * project_filament_count * new_extruder_count`). So the required length
 * is filaments^2 x extruders, NOT filaments^2 — the extruder factor is the part that is easy to
 * miss on a single-nozzle machine, where it is 1.
 *
 * WHY THIS EXISTS. A machine retarget that changes the extruder count (P1P 1 -> X2D/H2D 2) leaves
 * a matrix sized for the OLD extruder count. BambuStudio only *repairs* an undersized matrix
 * inside its flush-volume recompute block, which it skips unless the CLI passed
 * `--filament-colour`, the matrix is absent entirely, the extruder count differs from the
 * project's own, or `nozzle_volume_type` mismatches. A retarget satisfies none of those, so the
 * short matrix survives and the engine reads the second extruder's block out of bounds —
 * a deterministic SIGSEGV at ~71% ("Detect overhangs for auto-lift", CLI exit 139). Diagnosed
 * 2026-07-21 against BambuStudio 2.7.1.62; reproduced with a one-entry matrix on a 2-extruder
 * project and fixed by nothing but padding it to two entries.
 *
 * An ABSENT matrix is deliberately NOT a defect: absence is one of the conditions that makes
 * BambuStudio compute the matrix itself, so those projects slice correctly.
 */

/** What a project's stored matrix looks like next to what its topology requires. */
export interface FlushVolumesMatrixInspection {
  filamentCount: number
  extruderCount: number
  /** Stored entry count; 0 when the key is absent (which is not a defect). */
  actualLength: number
  expectedLength: number
  inconsistent: boolean
}

/**
 * Inspect a raw `project_settings.config` JSON string.
 *
 * Returns null when the settings are absent/unparseable or carry no filament list — callers must
 * treat that as "unknown", never as "healthy", so an unreadable project is not silently reported
 * as repaired.
 */
export function inspectProjectFlushVolumesMatrix(projectSettingsJson: string | null | undefined): FlushVolumesMatrixInspection | null {
  if (!projectSettingsJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  // Filament count comes from `filament_colour` (BambuStudio's own `project_filament_count`);
  // extruder count from `nozzle_diameter`, which has ONE ENTRY PER EXTRUDER — do not use the
  // deduplicated `extractProjectNozzleSizes`, which collapses a dual-0.4 machine back to one.
  const filamentCount = Array.isArray(record.filament_colour) ? record.filament_colour.length : 0
  const extruderCount = Array.isArray(record.nozzle_diameter) ? Math.max(record.nozzle_diameter.length, 1) : 1
  if (filamentCount <= 0) return null
  const matrix = Array.isArray(record.flush_volumes_matrix) ? record.flush_volumes_matrix : null
  return {
    filamentCount,
    extruderCount,
    actualLength: matrix?.length ?? 0,
    expectedLength: expectedFlushVolumesMatrixLength(filamentCount, extruderCount),
    inconsistent: isFlushVolumesMatrixInconsistent(matrix, filamentCount, extruderCount)
  }
}

/** Required entry count: one `filaments x filaments` block per extruder. */
export function expectedFlushVolumesMatrixLength(filamentCount: number, extruderCount: number): number {
  return filamentCount * filamentCount * Math.max(extruderCount, 1)
}

/**
 * True when `matrix` is present but does not match the topology.
 *
 * Undersized is the dangerous case (out-of-bounds read -> engine segfault); oversized is merely
 * wrong (the engine reads stale flush volumes out of the leading block). Both are reported so a
 * repair restores the documented shape. Returns false for an absent/empty matrix — see the module
 * header for why that case is safe.
 */
export function isFlushVolumesMatrixInconsistent(
  matrix: readonly unknown[] | null | undefined,
  filamentCount: number,
  extruderCount: number
): boolean {
  if (!matrix || matrix.length === 0) return false
  if (filamentCount <= 0) return false
  return matrix.length !== expectedFlushVolumesMatrixLength(filamentCount, extruderCount)
}

/**
 * Rebuild `matrix` to `filaments^2 x extruders`, preserving as much of the source as the shape
 * allows: each extruder block is copied from the matching source block, or from the LAST source
 * block when the source has fewer (the single-nozzle -> dual-nozzle retarget case, where the one
 * existing block is the right starting point for both extruders). Entries with no source fall back
 * to `"0"`, matching BambuStudio's own zero-fill.
 *
 * Returns null when the matrix is absent/empty or already the right length, so callers can treat
 * null as "nothing to do" and avoid rewriting a file needlessly.
 */
export function repairFlushVolumesMatrix(
  matrix: readonly unknown[] | null | undefined,
  filamentCount: number,
  extruderCount: number
): unknown[] | null {
  if (!matrix || matrix.length === 0) return null
  if (filamentCount <= 0) return null
  const expected = expectedFlushVolumesMatrixLength(filamentCount, extruderCount)
  if (matrix.length === expected) return null

  const block = filamentCount * filamentCount
  const sourceBlocks = Math.floor(matrix.length / block)
  const next: unknown[] = []
  for (let extruder = 0; extruder < Math.max(extruderCount, 1); extruder++) {
    const sourceBlock = sourceBlocks > 0 ? Math.min(extruder, sourceBlocks - 1) : 0
    for (let cell = 0; cell < block; cell++) {
      next.push(matrix[sourceBlock * block + cell] ?? '0')
    }
  }
  return next
}
