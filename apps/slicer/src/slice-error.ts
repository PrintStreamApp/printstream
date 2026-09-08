/**
 * BambuStudio CLI failure -> the one sentence the slice route throws.
 *
 * OWNS the per-shape formatters below AND the ORDER they are tried in ({@link classifyCliFailure}).
 * Pure, so both stay testable without spawning a CLI (index.ts boots the HTTP server on import).
 *
 * INVARIANT, and the reason the classifier takes two separate texts: **the progress frames and the
 * console output are different channels and are not interchangeable.** BambuStudio writes its
 * `{"message":...,"total_percent":N}` frames EXCLUSIVELY to the `--pipe` FIFO
 * (`cli_callback_mgr_t::notify` returns early when `m_pipe_fd < 0`, and `total_percent` appears
 * nowhere else in its source), while everything it prints goes to stdout/stderr. So the crash
 * grader, which decides transient-vs-deterministic by how far the run got, must be fed the pipe
 * channel. Fed stdout alone it reads every crash as 0% and calls it transient: an observed slice
 * aborted twice at "Detect overhangs for auto-lift", 66%, because the gate meant to stop the second
 * attempt could not see the percent that would have stopped it.
 *
 * COUNTERPART: the API's `isTransientSlicerCrashExit` (`apps/api/src/lib/slicing-jobs.ts`) keys its
 * one crash retry on the `Slicer CLI exited with code <N>` shape, so which message this returns
 * decides whether a failed slice is run again. See `cli-exit-codes.ts` for that prefix invariant.
 */
import { formatSliceCliExitError, resolveCliReturnCode } from './cli-exit-codes.js'
import { SLICING_STARTED_PERCENT, summarizeSliceProgress } from './slice-progress.js'

/** BambuStudio's `CLI_GCODE_PATH_CONFLICTS` (process exit 155). See {@link formatSliceToolpathConflictError}. */
const CLI_TOOLPATH_CONFLICT_RETURN_CODE = -101

/** The text channels a failed CLI run leaves behind. See the module header: these are not interchangeable. */
export interface CliFailureChannels {
  /**
   * Tail of EVERY channel the run produced, `--pipe` progress frames included. Only the crash
   * grader reads this, and it is the only input that carries `total_percent`.
   */
  allChannelsText: string
  /** Tail of the CLI's own stdout. */
  stdoutText: string
  /** Tail of the CLI's own stderr. */
  stderrText: string
  /** The process exit code, or null when it died without one. */
  exitCode: number | null
}

/**
 * The message to throw for a non-zero CLI exit, picking the most specific explanation that fits.
 *
 * Order is deliberate and each step is narrower than the one after it: a host-runtime mismatch is
 * not about the project at all; a version refusal and a preset incompatibility are both reported by
 * the CLI in its own words, which beat anything we could infer; the crash grader only applies to
 * signal deaths; and the exit-code table is the catch-all that preserves the retry prefix.
 */
export function classifyCliFailure(channels: CliFailureChannels): string {
  const consoleText = `${channels.stdoutText}\n${channels.stderrText}`

  const compatibilityError = formatRuntimeCompatibilityError(channels.stderrText)
  if (compatibilityError) return compatibilityError

  // A project saved by a NEWER Bambu Studio than this engine is refused outright before anything
  // loads (exit 232). Name that, or it reads as a broken model.
  const fileVersionError = formatSliceFileVersionError(consoleText)
  if (fileVersionError) return fileVersionError

  // BambuStudio reports preset/printer incompatibility on stdout and exits non-zero (code 251);
  // surface its reason instead of the opaque exit code.
  const presetError = formatSlicePresetIncompatibilityError(consoleText)
  if (presetError) return presetError

  // The engine names the two things whose toolpaths overlap. Lifting those names is the whole point:
  // the generic wording sent a user hunting the prime tower for a support collision. Gated on the
  // run having actually ENDED in that conflict, so a later, unrelated failure in a run that merely
  // logged one earlier still reports its own reason.
  if (resolveCliReturnCode(consoleText, channels.exitCode) === CLI_TOOLPATH_CONFLICT_RETURN_CODE) {
    const conflictError = formatSliceToolpathConflictError(consoleText)
    if (conflictError) return conflictError
  }

  // A signal death (134-139, surfaced by the launcher shell) AFTER the slice started is a
  // deterministic engine crash on this model's geometry. Graded on ALL channels, never on
  // `consoleText`: the percent it grades on only ever arrives over `--pipe`.
  if (channels.exitCode !== null && channels.exitCode >= 134 && channels.exitCode <= 139) {
    const engineCrash = formatSliceEngineCrashError(channels.allChannelsText, channels.exitCode)
    if (engineCrash) return engineCrash
  }

  return formatSliceCliExitError(consoleText, channels.exitCode)
}

/**
 * Turns the engine's toolpath-collision report (exit 155) into a message that NAMES what collided.
 *
 * BambuStudio's `ConflictChecker` buckets each object's perimeters AND its support, then reports the
 * first pair of extrusion lines belonging to different objects that intersect:
 *   `[error]   gcode path conflicts found between Mast Bottom and Mount`
 *   `[error]   plate 2: found slicing result conflict!`
 * Only when the purge tower is one of the two parties does it use the literal name `WipeTower`
 * (`ConflictChecker.cpp`, the `ptr1 == wtdp` branch), which is the ONLY case where "move the tower"
 * is the right advice. We used to give that advice for every 155, so a support collision between two
 * models read as a tower problem and had to be found by trial and error.
 *
 * The two names are deliberately NOT split apart: BambuStudio formats them as `%1% and %2%` and an
 * object may itself be called "Tracks and Cams", so there is no reliable split. The whole phrase is
 * quoted instead, and `WipeTower` is detected only at either end, where it is unambiguous.
 *
 * Returns null when the run carried no conflict report, leaving the exit-code table to answer.
 */
export function formatSliceToolpathConflictError(output: string): string | null {
  if (!output) return null
  const pair = output.match(/gcode path conflicts found between\s+(.+?)\s*$/mu)
  if (!pair?.[1]) return null
  const both = pair[1]
  const plate = output.match(/plate\s+(\d+):\s*found slicing result conflict/iu)
  const where = plate?.[1] ? ` on plate ${plate[1]}` : ''

  const TOWER = 'WipeTower'
  const leading = `${TOWER} and `
  const trailing = ` and ${TOWER}`
  if (both.startsWith(leading) || both.endsWith(trailing)) {
    const model = both.startsWith(leading) ? both.slice(leading.length) : both.slice(0, -trailing.length)
    return (
      `The purge tower collides with "${model}"${where}. `
      + `Move the purge tower somewhere clear of the models, or move that model.`
    )
  }

  return (
    `Two models collide${where}: the engine found overlapping toolpaths between ${both}. `
    + `Supports and brim print as part of a model and neither shows in the plate preview, `
    + `so check those before moving anything apart.`
  )
}

/**
 * Turns a missing-glibc/libstdc++ symbol death into a message about the HOST, not the project.
 *
 * The selected slicer binary can be built against a newer runtime than the image it is running in
 * (self-hosters pinning an engine version, mainly), which the loader reports as a `version ... not
 * found` line on stderr before the CLI executes a single instruction.
 */
export function formatRuntimeCompatibilityError(stderrText: string): string | null {
  if (!stderrText || !/GLIBCXX_|GLIBC_/i.test(stderrText) || !/version `[^']+' not found/i.test(stderrText)) {
    return null
  }
  const missingVersions = Array.from(new Set(
    stderrText
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/version `([^']+)' not found/i)
        return match?.[1] ? [match[1]] : []
      })
  ))
  const missingSummary = missingVersions.length > 0
    ? ` (${missingVersions.join(', ')})`
    : ''
  return `The selected slicer binary is incompatible with this host runtime${missingSummary}. Choose another slicer target or install a build compiled for this OS image.`
}

/**
 * Turns a BambuStudio CLI *engine crash* (a signal death: SIGABRT/SIGSEGV, which the launcher
 * shell surfaces as exit code 134-139) that happened **after the slice started** into a clear,
 * user-facing message that names the stage it died in.
 *
 * Why the post-load gate: a signal death during project *load/teardown* is often a transient
 * emulation flake that a re-run clears, so the caller keeps retrying those (returns null here). A
 * crash once the per-plate slice is underway is deterministic: the engine cannot process this
 * model's geometry at that stage, and it re-crashes identically on every retry (verified on a real
 * torus model that segfaults at "Detect overhangs for auto-lift" across every bundled engine version
 * and every print-setting/orientation permutation). Surfacing it as an actionable message, instead
 * of the opaque "exited with code 139", also makes the API skip the pointless retry, because the
 * message no longer matches its transient-crash predicate.
 *
 * Returns null when the run had not reached the slicing stage (leave it classified as transient).
 *
 * `output` MUST be the run's all-channel text, not its stdout/stderr: the `total_percent` this
 * grades on only ever arrives over the `--pipe` FIFO (see the module header). Fed console output
 * alone this returns null for every crash, silently disabling the gate. Callers go through
 * {@link classifyCliFailure}, which owns that wiring.
 */
export function formatSliceEngineCrashError(output: string, exitCode: number | null): string | null {
  const { lastStage, maxPercent } = summarizeSliceProgress(output)
  // Below the threshold the crash is load/teardown, i.e. transient.
  if (maxPercent < SLICING_STARTED_PERCENT) return null
  const stage = lastStage ? ` while processing "${lastStage}"` : ''
  return (
    `The slicing engine crashed${stage} on this model (engine exit ${exitCode ?? 'signal'}). ` +
    `This is an engine limitation on the model's geometry, not a print-setting problem, it will fail the same way on a retry. ` +
    `Try repairing or simplifying the model, re-exporting it from your CAD tool, or slicing a different plate.`
  )
}

/**
 * Turns BambuStudio's *project file version* refusal into a clear, user-facing message.
 *
 * BambuStudio refuses to open a 3MF saved by a NEWER version than itself, printing
 *   `[error]   Version Check: File Version 2.8.0.50 not supported by current cli version 02.07.01.62`
 * on **stdout** and exiting before it loads anything ("run found error, return -24" -> process exit
 * code 232). Nothing about the project is wrong and no setting can work around it: the engine
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
