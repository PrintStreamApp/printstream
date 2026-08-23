/**
 * The one degeneracy rule for a 3MF instance transform, shared by everything that produces one.
 *
 * OWNS the test for a transform BambuStudio will silently discard. `_apply_transform` checks the
 * scaling factor and returns EARLY, before `set_transformation` (`bbs_3mf.cpp:4299-4307`), so a
 * single zero scale axis does not merely flatten the object: the instance keeps its default identity
 * transformation and the object loses its position and its rotation as well, landing unrotated at
 * the plate origin. There is no error; the file opens and the model is simply somewhere else.
 *
 * WHY IT IS A MODULE RATHER THAN A ZOD REFINEMENT. It began as one, inside `threeMfTransformSchema`,
 * which meant it guarded the `matrix` field and nothing else. The TRS form (`position`/`rotation`/
 * `scale`) composes to the SAME twelve numbers (`threeMfTransformFromTRS`) and reached the file
 * unchecked, so the identical byte pattern was refused on one field and written from another. A rule
 * that only one of two paths can reach is the shape most of this catalogue's defects have.
 *
 * A NEGATIVE scale is legitimate and must pass: that is a mirror, which the editor offers, and a
 * basis column's LENGTH is unaffected by its sign. The test is length, never the raw factor.
 */

/**
 * The 1-based basis column that makes a transform degenerate, or null when it is usable.
 *
 * The lower bound matches the writer's own rounding: `formatThreeMfTransformValue` quantises to 1e-6,
 * so a column shorter than that serialises to literal zeros regardless of what it held in memory.
 * Checking against a tighter bound would pass values that then become the exact zero the engine
 * rejects. The upper bound is the schema's existing sanity limit for a runaway scale.
 */
export function findDegenerateTransformColumn(elements: readonly number[]): { column: number; length: number } | null {
  for (let column = 0; column < 3; column += 1) {
    const length = Math.hypot(elements[column * 3] ?? 0, elements[column * 3 + 1] ?? 0, elements[column * 3 + 2] ?? 0)
    if (length < 1e-6 || length > 1e6) return { column: column + 1, length }
  }
  return null
}

/** The wording both the schema and the bake report, so one failure does not read as two rules. */
export function degenerateTransformMessage(found: { column: number; length: number }): string {
  return `Transform basis column ${found.column} is degenerate (length ${found.length})`
}
