/**
 * BambuStudio CLI exit codes -> user-facing explanations.
 *
 * OWNS: turning the CLI's numeric failure into a sentence a user can act on. Without this every
 * non-zero exit surfaced as a bare `Slicer CLI exited with code 232`, which reads as "something
 * broke" no matter whether the real cause was an unsupported file version, an empty plate, or an
 * out-of-memory kill.
 *
 * HOW THE CODES WORK. BambuStudio calls `flush_and_exit(ret)` with a NEGATIVE return code (the
 * `CLI_*` constants in `libslic3r/Utils.hpp`) and prints `run found error, return <N>, exit...`.
 * The process exit code is the low byte, i.e. `256 + N`, so -24 surfaces as 232, -5 as 251,
 * -17 as 239. We prefer parsing the printed `return <N>` because it is unambiguous; the exit-code
 * arithmetic is only a fallback, and is deliberately NOT applied to 134-139, which are signal
 * deaths (128 + signal) that would otherwise collide with the -117..-122 range.
 *
 * The wording here is OURS, not BambuStudio's. Its own strings are written for MakerWorld's upload
 * pipeline ("...before uploading", "Please wait until MakerWorld supports them"), which is wrong
 * and confusing in PrintStream, and copying them verbatim would lift AGPL text into this file.
 *
 * CONTRACT: the returned message always KEEPS the `Slicer CLI exited with code <exit>` prefix.
 * The API's crash classifier (`isTransientSlicerCrashExit` in `apps/api/src/lib/slicing-jobs.ts`)
 * matches that exact shape to decide whether a signal death is worth one retry with UNCHANGED
 * inputs: changing the prefix silently disables that recovery. (There was also a compatibility
 * retry keyed on this prefix, which dropped the built-in profiles the engine rejected and sliced
 * on without them; it was removed because it changed the print and reported success.)
 *
 * Source of the code list: BambuStudio `src/libslic3r/Utils.hpp` (the `CLI_*` defines) cross-checked
 * against the `cli_errors` message map in `src/BambuStudio.cpp`. New codes in a future engine simply
 * fall through to the bare prefix, so an unmapped code is never worse than the old behaviour.
 */

/** BambuStudio `CLI_*` return code -> our explanation of it. */
const CLI_RETURN_CODE_MESSAGES: Record<number, string> = {
  [-1]: 'The slicer could not set up its environment.',
  [-2]: 'The slicer was called with invalid parameters.',
  [-3]: 'The slicer could not find its input files.',
  [-4]: 'The slicer received its input files in the wrong order.',
  [-5]: 'A preset handed to the slicer is invalid and could not be read.',
  [-6]: 'The model file could not be read. It may be corrupt or use an unsupported format.',
  [-7]: 'This project is not for an FDM printer, which is the only kind PrintStream slices.',
  [-8]: 'The slicer was asked to do something it does not support.',
  [-9]: 'The slicer failed while copying objects.',
  [-10]: 'The slicer could not scale an object to fit the plate.',
  [-11]: 'The slicer failed to export STL files.',
  [-12]: 'The slicer failed to export OBJ files.',
  [-13]: 'The slicer could not write its output file. This is usually a disk or permissions problem on the slicer host.',
  [-14]: 'The slicer ran out of memory. Try a lower-resolution model, a coarser layer height, or fewer objects per plate.',
  [-15]: 'This project cannot be switched to the selected printer.',
  [-16]: 'The selected printer is not compatible with this project.',
  [-17]: 'The selected print-settings preset is not compatible with the selected printer. Choose a process preset made for this printer.',
  [-18]: 'The project contains a setting value the slicer rejects.',
  [-19]: 'This project uses post-processing scripts, which the slicer cannot run.',
  [-20]: "The selected printer's bed is smaller than the bed the print profile expects.",
  [-21]: 'Auto-arranging the objects failed.',
  [-22]: 'Auto-orienting the objects failed.',
  [-23]: 'The project overrides the printable area, height, or exclude area, which the printer settings do not allow.',
  // -24 normally never reaches here: `formatSliceFileVersionError` produces a better message that
  // names both versions. This is the fallback if the CLI ever changes that log line.
  [-24]: 'This project was saved by a newer Bambu Studio than the slicer engine, so it cannot be opened. Re-save it from an older Bambu Studio, or slice it with a newer slicer version.',
  [-25]: 'This project uses experimental Bambu Studio features the slicer does not support.',
  [-50]: 'A plate is empty, or no object sits fully inside it. Check the plate has objects and they are within the bed.',
  [-51]: 'The project has slicing parameters the slicer rejects. Open it in Bambu Studio and confirm every plate slices.',
  [-52]: 'Some objects hang over the edge of the heated bed. Move them fully onto the plate.',
  [-53]: 'The slicer could not create its cache directory.',
  [-54]: 'The slicer could not write its cache data.',
  [-55]: 'The slicer could not find the cache data it expected.',
  [-56]: 'The slicer could not read its cache data.',
  [-57]: 'The slicer failed to load its cache data.',
  [-58]: 'A plate took too long to slice. Simplify the model or use a larger layer height.',
  [-59]: 'A plate has too many triangles. Simplify or decimate the model and try again.',
  [-60]: 'Nothing printable is left after skipping objects. Select at least one object to print.',
  [-61]: 'A chosen filament is not compatible with the plate type. Pick a different plate or filament.',
  [-62]: 'The chosen filaments need temperatures too far apart to print together.',
  [-63]: 'Objects collide in print-by-object mode. Space them further apart.',
  [-64]: 'Objects collide on the plate. Space them further apart.',
  [-65]: 'Some settings cannot be used with Spiral Vase mode.',
  [-66]: 'A filament could not be mapped to an extruder on this multi-extruder printer.',
  [-67]: 'Only one TPU filament can be printed at a time.',
  [-68]: 'A filament cannot be printed by the extruder it was mapped to. Check the per-material nozzle assignment.',
  [-100]: 'The slicing engine failed on this model. Open the project in Bambu Studio and confirm every plate slices.',
  // Only the fallback: `formatSliceToolpathConflictError` normally lifts the two names the engine
  // reports. Deliberately does NOT single out the prime tower, which is the rarer of the causes.
  [-101]: 'Toolpaths on the plate collide. Supports, brim, or the purge tower is likely reaching into another model. Check supports first, since they do not show in the plate preview.',
  [-102]: 'Toolpaths ended up in an area this multi-extruder printer cannot reach.',
  [-103]: 'A filament cannot be printed on the first layer of this plate type.',
  [-104]: 'Toolpaths ended up outside the printable area. Support, the prime tower, brim, or skirt is likely reaching past the bed.',
  [-105]: 'Toolpaths ended up inside the printer’s wrapping-detection area.'
}

/**
 * Resolve the BambuStudio `CLI_*` return code for a finished run.
 *
 * Prefers the CLI's own `run found error, return <N>` line; falls back to `exitCode - 256`, but
 * NEVER for 134-139 (signal deaths, handled by the engine-crash formatter) or for codes outside
 * the range the CLI actually uses.
 */
export function resolveCliReturnCode(output: string, exitCode: number | null): number | null {
  const printed = output.match(/run found error,\s*return\s+(-?\d+)/i)
  if (printed?.[1]) {
    const parsed = Number(printed[1])
    if (Number.isFinite(parsed)) return parsed
  }
  if (exitCode === null) return null
  if (exitCode >= 134 && exitCode <= 139) return null
  const derived = exitCode - 256
  return derived in CLI_RETURN_CODE_MESSAGES ? derived : null
}

/**
 * The final fallback message for a non-zero CLI exit: the `Slicer CLI exited with code <N>` shape
 * the API classifies on, plus an explanation when we recognise the code.
 */
export function formatSliceCliExitError(output: string, exitCode: number | null): string {
  const prefix = `Slicer CLI exited with code ${exitCode ?? 'unknown'}`
  const returnCode = resolveCliReturnCode(output, exitCode)
  const detail = returnCode === null ? null : CLI_RETURN_CODE_MESSAGES[returnCode]
  const engine = extractEngineErrorLine(output)
  const rejected = returnCode === CLI_INVALID_VALUES ? extractRejectedSettingKeys(output) : []
  const named = rejected.length > 0 ? `${detail ?? ''} Rejected: ${rejected.join(', ')}.`.trim() : detail
  const explained = named ? `${prefix}: ${named}` : prefix
  return engine ? `${explained} (engine: ${engine})` : explained
}

/** `CLI_INVALID_VALUES_IN_3MF`: the engine refused one or more setting VALUES before slicing. */
const CLI_INVALID_VALUES = -18

/**
 * Which settings the engine rejected, lifted from its own report.
 *
 * The CLI runs `DynamicPrintConfig::validate` before slicing and prints every offending option to
 * stderr under a `Param values in 3mf/config error:` header, one `key: reason` per line. Without
 * those keys the message says a value is rejected and leaves the user to guess which of several
 * hundred settings it was.
 *
 * Read from the ENGINE rather than re-derived from our own option bounds on purpose. We carry
 * `min`/`max` on every option and could sweep them ourselves, but that would be a second
 * implementation of the engine's rule, free to disagree with the engine it exists to predict, and
 * it is exactly that shape of duplication that produces the defects this codebase keeps repairing.
 * The engine has already answered; this only reports the answer.
 *
 * Keys only, not the reasons: the reasons are BambuStudio's own strings, and the point here is to
 * say where to look.
 */
function extractRejectedSettingKeys(output: string): string[] {
  const keys: string[] = []
  let inBlock = false
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^Param values in 3mf\/config error:/i.test(line)) { inBlock = true; continue }
    if (!inBlock) continue
    // The block runs until anything that is not a `key: reason` pair, which is where the engine's
    // own exit logging resumes.
    const match = line.match(/^([a-z0-9_]+):\s*\S/i)
    if (!match?.[1]) break
    if (!keys.includes(match[1])) keys.push(match[1])
  }
  return keys
}

/**
 * The engine's OWN last words before it gave up: e.g. `Flush volumes matrix do not match to the
 * correct size!`.
 *
 * The generic codes (-100 above all) say "slicing failed" and nothing else, while BambuStudio
 * usually prints the actual reason a line or two earlier. Without this that reason exists only in
 * the job's output log, which means the difference between a user knowing what is wrong and a
 * maintainer going and reading 48 lines of progress JSON. Ryan hit exactly that.
 *
 * Deliberately conservative about what counts: progress JSON, `[warning]` chatter and the
 * `run found error` line itself are noise, and an unbounded tail would paste a wall of log into a
 * toast. Takes the LAST qualifying line, since the engine prints its specific complaint
 * immediately before bailing out.
 */
function extractEngineErrorLine(output: string): string | null {
  // Scans the WHOLE output, both streams. It must NOT stop at `run found error`: that line is on
  // stdout while the specific complaint often lands on stderr, and the two arrive concatenated:
  // stopping there picked the vague `found slicing or export error for partplate 1` over the
  // useful `Flush volumes matrix do not match to the correct size!` sitting in the other stream.
  let tagged: string | null = null
  let bare: string | null = null
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('{')) continue
    if (/\[warning\]/i.test(line)) continue
    if (/run found error/i.test(line)) continue
    if (/^Slicer CLI exited with code/i.test(line)) continue
    if (/\[error\]/i.test(line)) {
      // Strip the boost log prefix (`[timestamp] [thread] [error]  `) so the sentence reads plainly.
      const cleaned = line.replace(/^\[[^\]]*\]\s*\[[^\]]*\]\s*\[[^\]]*\]\s*/, '').trim()
      if (cleaned.length > 0 && cleaned.length <= 200) tagged = cleaned
      continue
    }
    // A bare line (no log prefix at all) is the engine complaining in its own words, which is
    // consistently more specific than its tagged "something failed on plate N" counterpart.
    if (!line.startsWith('[') && line.length <= 200) bare = line
  }
  return bare ?? tagged
}
