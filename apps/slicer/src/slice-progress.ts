/**
 * Pure helpers for interpreting BambuStudio CLI progress output.
 *
 * Kept out of index.ts (which boots the HTTP server on import) so the matchers are
 * unit-testable without starting the service.
 */

/**
 * BambuStudio prints this exact progress line once a slice — including the final
 * gcode/3MF export — has fully succeeded. It is the last message before the process
 * exits, so seeing it means the output file is completely written.
 *
 * Under qemu emulation (arm64 dev / self-host) the process can then hang in teardown
 * without ever firing `close`, leaving the slice "stuck at 97% (Exporting 3mf)". The
 * slicer treats this marker (plus a short grace period for a clean exit) as completion
 * so a wedged teardown no longer waits out the full slice timeout.
 */
export function outputSignalsSliceComplete(text: string): boolean {
  return /"message"\s*:\s*"All done,\s*Success"/u.test(text)
}

/** A BambuStudio progress line's `message` (the stage name) plus its `total_percent`. */
const SLICE_STAGE_PATTERN = /"message"\s*:\s*"([^"]+)"[^}]*?"total_percent"\s*:\s*(\d+)/gu

/**
 * The `total_percent` at which BambuStudio has finished loading the project and started the actual
 * per-plate slice ("Slicing begins"). A crash at or beyond this point is happening in the slicing
 * engine on the model's geometry, not in project load/teardown — the distinction the caller uses to
 * separate a deterministic engine crash (do not retry, name the stage) from a transient load/teardown
 * flake (still worth one retry under emulation). Kept as a percent (not the stage string) so a locale
 * or wording change upstream doesn't silently reclassify every crash as transient.
 */
const SLICING_STARTED_PERCENT = 6

/**
 * The last-reported stage name and the highest `total_percent` seen in a run's CLI output. `lastStage`
 * is the stage the process was in when output stopped (i.e. where it crashed); `maxPercent` gauges how
 * far the run got. Both are null/0 when the output carried no parseable progress line (e.g. a crash
 * during project load, before the first stage prints).
 */
export function summarizeSliceProgress(text: string): { lastStage: string | null; maxPercent: number } {
  let lastStage: string | null = null
  let maxPercent = 0
  for (const match of text.matchAll(SLICE_STAGE_PATTERN)) {
    lastStage = match[1] ?? lastStage
    maxPercent = Math.max(maxPercent, Number(match[2]))
  }
  return { lastStage, maxPercent }
}

/** Whether the run got past project load into the actual per-plate slice (see {@link SLICING_STARTED_PERCENT}). */
export function outputReachedSlicingStage(text: string): boolean {
  return summarizeSliceProgress(text).maxPercent >= SLICING_STARTED_PERCENT
}
