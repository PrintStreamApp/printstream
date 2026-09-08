/**
 * Whether the bed surface already standing in the viewport is STALE.
 *
 * OWNS the one question the editor's INCREMENTAL (empty-plate) build asks before it reuses the bed
 * it finds on the plate: would rebuilding produce a different bed? The atomic (staging) build path
 * rebuilds unconditionally and asks nothing, so on a plate with no models this predicate is the only
 * thing between a printer switch and a plate that no longer matches the printer.
 *
 * It is a CORRECTNESS predicate, not an optimisation: it names every input the bed is built from and
 * never reasons about which of them "must already be right". It used to answer whether a 3D plate
 * mesh was PRESENT (`Boolean(geometry)`) rather than WHICH mesh, so switching printer models left
 * the previous printer's plate rendered under the new printer's grid -- an A1 plate sitting in the
 * front-left corner of an H2D bed -- and nothing corrected it afterwards, because adding a model to
 * an empty plate still takes the incremental path.
 *
 * The mesh is identified by IDENTITY, not by the printer it was fetched for: `loadBedModelGeometry`
 * replaces the cached geometry wholesale on every fetch, so re-fetching the SAME printer yields a
 * new object and rebuilds a bed that was already correct. That is the safe direction to be wrong in,
 * and it costs one grid plus one mesh clone, on a gesture the user just made.
 */

/** Everything `EditorView` builds a bed surface from. Mirrors the arguments it passes. */
export interface BedSurfaceSignatureInput {
  /** Printable width (mm), as drawn by the millimetre grid. */
  width: number
  /** Printable depth (mm). */
  depth: number
  /** Scene X of the printable area's centre. */
  centerX: number
  /** Scene Y of the printable area's centre. */
  centerY: number
  /** Unprintable regions drawn on the grid. */
  excludeAreas: ReadonlyArray<{ polygon: ReadonlyArray<{ x: number; y: number }>; label: string | null }>
  /**
   * The printer's modelled 3D plate, or null when only the grid is drawn (the option is off, or
   * this printer ships no mesh). Structural rather than a `THREE.BufferGeometry` so the rule stays
   * testable without a renderer; `uuid` is what makes one parsed mesh distinguishable from another.
   */
  bedModel: { uuid: string } | null
}

/** Opaque token: equal signatures mean the standing bed is still the one this input would build. */
export function bedSurfaceSignature(input: BedSurfaceSignatureInput): string {
  return JSON.stringify([
    input.width,
    input.depth,
    input.centerX,
    input.centerY,
    input.excludeAreas,
    input.bedModel?.uuid ?? null
  ])
}
