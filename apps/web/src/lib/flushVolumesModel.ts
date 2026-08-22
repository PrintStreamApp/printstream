/**
 * What the flushing-volumes dialog SHOWS, as pure functions.
 *
 * The dialog renders icons, and a component render test cannot mount an `@mui/icons-material` icon
 * under the node runner's CJS interop (see the web development notes) — so its decisions live here and
 * are tested through their inputs instead, the same split `lib/processBulkOverrides.ts` uses for
 * `ProcessSettingsDialog`.
 *
 * These are decisions, not formatting: which numbers the grid opens on (the project's own, or a
 * preview it must not silently adopt) and how confidently the footnote may describe where they came
 * from. Both have a wrong answer that misleads rather than merely looks off.
 */
import type { FlushCalibrationVerdict, ProjectFlushContext } from '@printstream/shared'

/**
 * The blocks the grid opens on, for the SESSION's material count.
 *
 * The project's stored matrix is used only when it still fits what the session is showing —
 * a material added or removed since it was written makes it describe purges between filaments that
 * are no longer there. When it does not fit, the grid opens on the suggestion instead, which the
 * caller pairs with the "this is a preview" state so nothing is adopted without the user acting.
 */
export function seedFlushBlocks(input: {
  context: ProjectFlushContext
  filamentCount: number
  suggestion: (extruderIndex: number) => number[][]
}): number[][][] {
  const { context } = input
  const stored = context.storedBlocks
  const usable = stored !== null
    && stored.length === context.extruderCount
    && stored.every((block) => block.length === input.filamentCount)
  return Array.from({ length: context.extruderCount }, (_unused, extruderIndex) =>
    usable ? stored[extruderIndex]! : input.suggestion(extruderIndex))
}

/**
 * Whether the grid is showing the project's OWN volumes or a preview of what would be computed.
 *
 * A project may legitimately carry no matrix — that absence is what makes BambuStudio compute one
 * at slice time — so opening the dialog must not materialise one. Preview ends the moment the user
 * touches anything, which is when the numbers become the project's.
 */
export function isPreviewingFlushVolumes(input: {
  context: ProjectFlushContext
  touched: boolean
}): boolean {
  return !input.touched && input.context.storedBlocks === null
}

/** The four things the footnote can honestly say, most confident first. */
export type FlushProvenance = 'engine-verified' | 'engine-disagrees' | 'measured-unverified' | 'formula-only'

/**
 * How the numbers on screen were arrived at.
 *
 * The ordering matters: a verdict — agreeing OR disagreeing — outranks having the measured tables,
 * because it was checked against the engine that will actually slice rather than assumed. "Not
 * checked" (no slicer to ask, an engine too old to probe) must never collapse into "agrees": the
 * whole point of the calibration probe is that we stop claiming parity we did not verify.
 */
export function resolveFlushProvenance(input: {
  hasMeasuredTables: boolean
  calibration: FlushCalibrationVerdict | null
}): FlushProvenance {
  if (input.calibration?.agrees === true) return 'engine-verified'
  if (input.calibration?.agrees === false) return 'engine-disagrees'
  return input.hasMeasuredTables ? 'measured-unverified' : 'formula-only'
}

/** User-facing wording per provenance. Kept beside the decision so the two cannot drift. */
export const FLUSH_PROVENANCE_NOTE: Record<FlushProvenance, string> = {
  'engine-verified': 'Calculated the way Bambu Studio does, and checked against this slicer’s own numbers.',
  'engine-disagrees': 'Calculated the way Bambu Studio does, but this slicer works these out slightly differently — treat them as a starting point.',
  'measured-unverified': 'Calculated the way Bambu Studio does, using its measured purge volumes for colours it has data for.',
  'formula-only': 'Calculated from the material colours. Bambu Studio’s measured purge data isn’t available here, so its numbers may differ slightly.'
}
