/**
 * The flush-volume sizing invariants for Bambu `project_settings.config`: `flush_volumes_matrix`
 * and its per-extruder companion `flush_multiplier`.
 *
 * OWNS: deciding whether a project's flush sizing matches its machine topology, and rebuilding the
 * pieces that do not. Pure string/array work — the callers own their own ZIP/HTTP I/O.
 *
 * CONTRACT. BambuStudio stores the matrix as `extruder_count` CONSECUTIVE BLOCKS, each a
 * `filament_count x filament_count` row-major matrix (`PrintConfig.hpp`
 * `get_flush_volumes_matrix`/`set_flush_volumes_matrix` slice block `e` as
 * `[size/nozzles*e, size/nozzles*(e+1))`; `BambuStudio.cpp` sizes it
 * `project_filament_count * project_filament_count * new_extruder_count`). So the required length
 * is filaments^2 x extruders, NOT filaments^2 — the extruder factor is the part that is easy to
 * miss on a single-nozzle machine, where it is 1. `flush_multiplier` (and `flush_multiplier_fast`)
 * carry ONE ENTRY PER EXTRUDER; old single-nozzle saves store a bare scalar, which BambuStudio
 * parses as a one-entry list.
 *
 * WHY THE MATRIX RULE EXISTS. A machine retarget that changes the extruder count (P1P 1 ->
 * X2D/H2D 2) leaves a matrix sized for the OLD extruder count. BambuStudio only *repairs* an
 * undersized matrix inside its flush-volume recompute block, which it skips unless the CLI passed
 * `--filament-colour`, the matrix is absent entirely, the extruder count differs from the
 * project's own, or `nozzle_volume_type` mismatches. A retarget satisfies none of those, so the
 * short matrix survives and the engine reads the second extruder's block out of bounds —
 * a deterministic SIGSEGV at ~71% ("Detect overhangs for auto-lift", CLI exit 139). Diagnosed
 * 2026-07-21 against BambuStudio 2.7.1.62; reproduced with a one-entry matrix on a 2-extruder
 * project and fixed by nothing but padding it to two entries.
 *
 * WHY THE MULTIPLIER RULE EXISTS. `GCode.cpp` validates the matrix against
 * `filament_colour.size()^2 * flush_multiplier.size()` — the heads count comes from
 * `flush_multiplier`, NOT `nozzle_diameter` — escaping only when the filament count is exactly 1.
 * So a project whose matrix is correct by OUR rule but whose multiplier still has the old
 * machine's length fails every multi-filament slice at "Generating G-code" with
 * "Flush volumes matrix do not match to the correct size!" (CLI exit 156, return -100). An ABSENT
 * multiplier is just as fatal on a multi-extruder machine: the engine's default is the one-entry
 * `{1.0}`. Diagnosed 2026-08-11 (prod, an X2D project), A/B-reproduced against the real CLI:
 * `['1']` -> exit 156, `['1','1']` -> clean g-code.
 *
 * An ABSENT matrix is deliberately NOT a defect: absence is one of the conditions that makes
 * BambuStudio compute the matrix itself, so those projects slice correctly. The multiplier
 * detection is likewise gated on the recompute NOT firing — see
 * {@link isFlushMultiplierInconsistent} for the exact model.
 */

/** What a project's stored flush sizing looks like next to what its topology requires. */
export interface FlushVolumesMatrixInspection {
  filamentCount: number
  extruderCount: number
  /** Stored matrix entry count; 0 when the key is absent (which is not a defect). */
  actualLength: number
  expectedLength: number
  /**
   * The `flush_multiplier` length the ENGINE will see: stored entries, a scalar counting as one,
   * and absence counting as one (the engine default is the one-entry `{1.0}`).
   */
  multiplierLength: number
  /** The matrix does not match the topology (the exit-139 out-of-bounds/segfault class). */
  matrixInconsistent: boolean
  /** The multiplier will fail the engine's g-code-time size check (the exit-156 class). */
  multiplierInconsistent: boolean
  /** Either defect — what `collectSettingsRepairReasons` reports as `flushMatrix`. */
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
  const matrixInconsistent = isFlushVolumesMatrixInconsistent(matrix, filamentCount, extruderCount)
  const multiplierInconsistent = isFlushMultiplierInconsistent(record, filamentCount, extruderCount)
  return {
    filamentCount,
    extruderCount,
    actualLength: matrix?.length ?? 0,
    expectedLength: expectedFlushVolumesMatrixLength(filamentCount, extruderCount),
    multiplierLength: effectiveFlushMultiplierLength(record.flush_multiplier),
    matrixInconsistent,
    multiplierInconsistent,
    inconsistent: matrixInconsistent || multiplierInconsistent
  }
}

/**
 * Which multiplier key a project's purge volumes are scaled by.
 *
 * BambuStudio keeps two, and `prime_volume_mode` picks between them: its flushing dialog reads and
 * WRITES `flush_multiplier_fast` in Fast mode and `flush_multiplier` otherwise
 * (`WipeTowerDialog.cpp`). Both the editor and the bake go through this so an edit made in one mode
 * cannot be written to the key the other reads — which would look like the edit silently did
 * nothing. Any unrecognised/absent mode means the default, matching the config's own default.
 */
export function flushMultiplierKeyForPrimeVolumeMode(mode: unknown): 'flush_multiplier' | 'flush_multiplier_fast' {
  return mode === 'Fast' ? 'flush_multiplier_fast' : 'flush_multiplier'
}

/** BambuStudio's per-key defaults: 1 for the normal multiplier, 1.2 for the fast one. */
export function defaultFlushMultiplierFor(key: 'flush_multiplier' | 'flush_multiplier_fast'): string {
  return key === 'flush_multiplier_fast' ? '1.2' : '1'
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
 * True when the stored `flush_multiplier` will make BambuStudio reject the slice outright
 * (exit 156, "Flush volumes matrix do not match to the correct size!").
 *
 * This deliberately models the ENGINE's behaviour rather than flagging every off-length value,
 * because a flagged file blocks print-prep and several off-length shapes slice fine today:
 *  - matrix absent: the CLI recomputes matrix AND multiplier itself — healthy.
 *  - one filament: `GCode.cpp` escapes its size check entirely — healthy.
 *  - `nozzle_volume_type` length differing from the extruder count (including absent): that very
 *    mismatch triggers the CLI's flush recompute, which resizes the multiplier — healthy. Verified
 *    against real library files (a 5-filament dual-nozzle project with `['1']` + a one-entry
 *    `nozzle_volume_type` slices clean; the same multiplier with a consistent two-entry
 *    `nozzle_volume_type` is the reproduced exit 156). The recompute's remaining triggers cannot
 *    apply to a file we hand the CLI: we never pass `--filament-colour`, and the loaded machine's
 *    extruder count always equals the project's own (a cross-machine slice retargets the project
 *    natively before the CLI sees it).
 *  - `flush_multiplier_fast` is NOT checked: the engine reads it only in fast purge mode, and
 *    genuine Bambu Studio dual-nozzle saves routinely carry a one-entry value there — flagging it
 *    would mark shipping-and-slicing files defective.
 */
export function isFlushMultiplierInconsistent(
  record: Record<string, unknown>,
  filamentCount: number,
  extruderCount: number
): boolean {
  if (filamentCount < 2) return false
  const matrix = Array.isArray(record.flush_volumes_matrix) ? record.flush_volumes_matrix : null
  if (!matrix || matrix.length === 0) return false
  const nozzleVolumeTypeLength = Array.isArray(record.nozzle_volume_type)
    ? record.nozzle_volume_type.length
    : record.nozzle_volume_type != null ? 1 : 0
  if (nozzleVolumeTypeLength !== Math.max(extruderCount, 1)) return false
  return effectiveFlushMultiplierLength(record.flush_multiplier) !== Math.max(extruderCount, 1)
}

/** The multiplier length the engine sees: entries, a scalar as 1, absence as the default's 1. */
function effectiveFlushMultiplierLength(value: unknown): number {
  if (Array.isArray(value)) return value.length
  return 1
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

/**
 * Read one extruder's `filaments x filaments` block out of the stored flat matrix.
 *
 * Mirrors BambuStudio's `get_flush_volumes_matrix`, which slices block `e` as
 * `[size/nozzles*e, size/nozzles*(e+1))`. Returns null when the stored matrix is absent or does not
 * hold that block at the given topology — callers must then show "not set" (BambuStudio computes
 * the matrix itself when it is absent) rather than rendering a grid of zeroes, which would read as
 * "purge nothing" and, if saved, mean exactly that.
 */
export function readFlushVolumesMatrixBlock(
  matrix: readonly unknown[] | null | undefined,
  extruderIndex: number,
  filamentCount: number,
  extruderCount: number
): number[][] | null {
  if (!matrix || matrix.length === 0 || filamentCount <= 0) return null
  if (matrix.length !== expectedFlushVolumesMatrixLength(filamentCount, extruderCount)) return null
  if (extruderIndex < 0 || extruderIndex >= Math.max(extruderCount, 1)) return null
  const block = filamentCount * filamentCount
  const base = extruderIndex * block
  return Array.from({ length: filamentCount }, (_unused, row) =>
    Array.from({ length: filamentCount }, (_cell, column) => {
      const value = Number(matrix[base + row * filamentCount + column])
      return Number.isFinite(value) ? value : 0
    }))
}

/**
 * Flatten per-extruder blocks back into the stored representation (strings, as Bambu writes them).
 *
 * The inverse of {@link readFlushVolumesMatrixBlock}. Every block must be `filaments x filaments`
 * and there must be one per extruder: this is the shape whose violation segfaults the engine
 * (see the module header), so it throws rather than writing a matrix that would.
 */
export function writeFlushVolumesMatrixBlocks(blocks: ReadonlyArray<ReadonlyArray<readonly number[]>>): string[] {
  const filamentCount = blocks[0]?.length ?? 0
  if (blocks.length === 0 || filamentCount === 0) {
    throw new Error('flush_volumes_matrix needs at least one filament x filament block')
  }
  const out: string[] = []
  for (const block of blocks) {
    if (block.length !== filamentCount) {
      throw new Error(`flush_volumes_matrix blocks must all be ${filamentCount} rows`)
    }
    for (const row of block) {
      if (row.length !== filamentCount) {
        throw new Error(`flush_volumes_matrix rows must be ${filamentCount} wide`)
      }
      for (const cell of row) out.push(String(Math.round(cell)))
    }
  }
  return out
}

/**
 * Resize a `flush_multiplier`/`flush_multiplier_fast` value to one entry per extruder: existing
 * entries are kept (a legacy bare scalar counts as one), a grown tail repeats the last entry, and
 * a value with no entries at all is authored from `padDefault` — BambuStudio's own defaults are
 * `'1'` (normal) and `'1.2'` (fast), which is also exactly what its recompute writes, so this is a
 * derivation rather than a guess.
 *
 * Returns null when the value already has one entry per extruder, or when it is ABSENT and the
 * machine has one extruder (absence equals the engine's one-entry default there, and writing a key
 * the file never carried would churn bytes for nothing).
 */
export function repairFlushMultiplier(
  value: unknown,
  extruderCount: number,
  padDefault = '1'
): unknown[] | null {
  const extruders = Math.max(extruderCount, 1)
  const entries = Array.isArray(value) ? value : value != null ? [value] : []
  if (entries.length === extruders) return null
  if (entries.length === 0 && extruders === 1) return null
  return Array.from({ length: extruders }, (_unused, index) =>
    entries[Math.min(index, entries.length - 1)] ?? padDefault)
}
