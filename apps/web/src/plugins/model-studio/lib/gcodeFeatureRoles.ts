/**
 * BambuStudio's G-code feature roles: the labels it emits in `; FEATURE:` and the index each one
 * occupies in the preview's colour palette.
 *
 * Its own tiny module, THREE-free, because two very different consumers need the numbering and
 * neither should drag the other in: `gcodePreview.ts` (which imports the whole Three.js graph to
 * build toolpath meshes) and `gcodeConflicts.ts` (a pure segment scan that could otherwise run in a
 * worker or a plain node test). Importing the preview for six integers made the renderer an eager
 * dependency of the scanner.
 *
 * {@link GCODE_FEATURE_ROLES} is DERIVED from {@link GCODE_FEATURE_NAMES}, not written out beside
 * it. A hand-kept map is the same hazard as the bare indices it replaced: inserting a role shifts
 * every later index, and a parallel structure that did not move with it would keep answering the
 * old numbers with nothing to fail. `gcodeFeatureRoles.test.ts` pins the two together.
 */

/** Display names, parallel to `GCODE_FEATURE_COLORS` in `gcodePreview.ts` (Bambu's role labels). */
export const GCODE_FEATURE_NAMES: ReadonlyArray<string> = [
  'Other',
  'Inner wall',
  'Outer wall',
  'Overhang wall',
  'Sparse infill',
  'Internal solid infill',
  'Top surface',
  'Bottom surface',
  'Ironing',
  'Bridge',
  'Gap infill',
  'Skirt',
  'Brim',
  'Support',
  'Support interface',
  'Prime tower',
  'Custom',
  'Flush'
]

function roleIndex(label: string): number {
  const index = GCODE_FEATURE_NAMES.indexOf(label)
  // Thrown at module load rather than answered with -1: a wrong role silently exempts the wrong
  // feature from the conflict scan, or colours a toolpath as something it is not.
  if (index < 0) throw new Error(`Unknown G-code feature role: ${label}`)
  return index
}

/** Named indices into {@link GCODE_FEATURE_NAMES}, for consumers that reason about a specific role. */
export const GCODE_FEATURE_ROLES = Object.freeze({
  other: roleIndex('Other'),
  innerWall: roleIndex('Inner wall'),
  outerWall: roleIndex('Outer wall'),
  overhangWall: roleIndex('Overhang wall'),
  sparseInfill: roleIndex('Sparse infill'),
  internalSolidInfill: roleIndex('Internal solid infill'),
  topSurface: roleIndex('Top surface'),
  bottomSurface: roleIndex('Bottom surface'),
  ironing: roleIndex('Ironing'),
  bridge: roleIndex('Bridge'),
  gapInfill: roleIndex('Gap infill'),
  skirt: roleIndex('Skirt'),
  brim: roleIndex('Brim'),
  support: roleIndex('Support'),
  supportInterface: roleIndex('Support interface'),
  primeTower: roleIndex('Prime tower'),
  custom: roleIndex('Custom'),
  flush: roleIndex('Flush')
})
