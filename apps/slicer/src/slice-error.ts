import { summarizeSliceProgress } from './slice-progress.js'

/**
 * Turns a BambuStudio CLI *engine crash* (a signal death — SIGABRT/SIGSEGV, which the xvfb-run
 * wrapper surfaces as exit code 134-139) that happened **after the slice started** into a clear,
 * user-facing message that names the stage it died in.
 *
 * Why the post-load gate: a signal death during project *load/teardown* is often a transient
 * emulation flake that a re-run clears, so the caller keeps retrying those (returns null here). A
 * crash once the per-plate slice is underway is deterministic — the engine cannot process this
 * model's geometry at that stage, and it re-crashes identically on every retry (verified on a real
 * torus model that segfaults at "Detect overhangs for auto-lift" across every bundled engine version
 * and every print-setting/orientation permutation). Surfacing it as an actionable message — instead
 * of the opaque "exited with code 139" — also makes the API skip the pointless retry, because the
 * message no longer matches its transient-crash predicate.
 *
 * Returns null when the run had not reached the slicing stage (leave it classified as transient).
 */
export function formatSliceEngineCrashError(output: string, exitCode: number | null): string | null {
  const { lastStage, maxPercent } = summarizeSliceProgress(output)
  // Mirror slice-progress.ts's SLICING_STARTED_PERCENT; below it the crash is load/teardown → transient.
  if (maxPercent < 6) return null
  const stage = lastStage ? ` while processing "${lastStage}"` : ''
  return (
    `The slicing engine crashed${stage} on this model (engine exit ${exitCode ?? 'signal'}). ` +
    `This is an engine limitation on the model's geometry, not a print-setting problem — it will fail the same way on a retry. ` +
    `Try repairing or simplifying the model, re-exporting it from your CAD tool, or slicing a different plate.`
  )
}

/**
 * Turns BambuStudio's *project file version* refusal into a clear, user-facing message.
 *
 * BambuStudio refuses to open a 3MF saved by a NEWER version than itself, printing
 *   `[error]   Version Check: File Version 2.8.0.50 not supported by current cli version 02.07.01.62`
 * on **stdout** and exiting before it loads anything ("run found error, return -24" -> process exit
 * code 232). Nothing about the project is wrong and no setting can work around it — the engine
 * simply predates the file. Without this the user sees only "Slicer CLI exited with code 232",
 * which reads as a broken model rather than "save it from an older Bambu Studio, or slice it with a
 * newer engine".
 *
 * This is a routine occurrence, not an edge case: it fires for every project saved by a desktop
 * Bambu Studio newer than the bundled engines, so the fix is usually to add that engine as a slicer
 * target (`apps/slicer/docker/slicer-targets.mjs`) rather than to change anything about the file.
 */
export function formatSliceFileVersionError(output: string): string | null {
  if (!output) return null
  for (const rawLine of output.split(/\r?\n/)) {
    const match = rawLine.match(/Version Check:\s*File Version\s+([\d.]+)\s+not supported by current cli version\s+([\d.]+)/i)
    if (match) {
      const fileVersion = normalizeBambuVersion(match[1]!)
      const cliVersion = normalizeBambuVersion(match[2]!)
      return (
        `This project was saved by Bambu Studio ${fileVersion}, which is newer than the slicer engine (${cliVersion}). ` +
        `Bambu Studio refuses to open a project from a newer version, so it can't be sliced as-is. ` +
        `Pick a newer slicer version if one is available, or re-save the project from Bambu Studio ${cliVersion} or older and upload it again.`
      )
    }
  }
  return null
}

/** `02.07.01.62` -> `2.7.1.62`; BambuStudio prints the CLI version zero-padded and the file version not. */
function normalizeBambuVersion(version: string): string {
  return version.split('.').map((part) => String(Number(part))).join('.')
}

/**
 * Turns BambuStudio CLI slice-time *preset/printer incompatibility* output into a
 * clear, user-facing message.
 *
 * When a filament (or other) preset is not compatible with the target machine,
 * the CLI prints a line like:
 *   `[error]   run 3008: filament preset Bambu PLA Basic @BBL A1 (slot 1) is not compatible with printer Bambu Lab A1 mini 0.4 nozzle.`
 * on **stdout** (not stderr) and exits non-zero ("run found error, return -5" ->
 * process exit code 251). Without this, the failure surfaces only as the opaque
 * "Slicer CLI exited with code 251", which is what made these failures look like
 * "no error" to users. We scan the combined CLI output and lift the CLI's own
 * (already human-readable) reason into the thrown error.
 */
export function formatSlicePresetIncompatibilityError(output: string): string | null {
  if (!output) return null
  for (const rawLine of output.split(/\r?\n/)) {
    // Capture from "<kind> preset ... is not compatible with printer ..." to end of line,
    // dropping the CLI's timestamp/level/"run NNNN:" prefix.
    const match = rawLine.match(/((?:\w+\s+)?preset\b.*?\bis not compatible with printer\b.*)$/i)
    if (match?.[1]) {
      const detail = match[1].trim().replace(/[.\s]+$/, '')
      return `Bambu Studio can't slice this project as set up: ${detail}. Pick a filament and process preset made for the selected printer, then slice again.`
    }
  }
  return null
}
