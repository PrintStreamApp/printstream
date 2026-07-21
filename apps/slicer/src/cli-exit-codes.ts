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
 * The process exit code is the low byte, i.e. `256 + N` — so -24 surfaces as 232, -5 as 251,
 * -17 as 239. We prefer parsing the printed `return <N>` because it is unambiguous; the exit-code
 * arithmetic is only a fallback, and is deliberately NOT applied to 134-139, which are signal
 * deaths (128 + signal) that would otherwise collide with the -117..-122 range.
 *
 * The wording here is OURS, not BambuStudio's. Its own strings are written for MakerWorld's upload
 * pipeline ("...before uploading", "Please wait until MakerWorld supports them"), which is wrong
 * and confusing in PrintStream, and copying them verbatim would lift AGPL text into this file.
 *
 * CONTRACT: the returned message always KEEPS the `Slicer CLI exited with code <exit>` prefix.
 * The API's retry classifier (`isLikelyBuiltinProfileCompatibilityExit` in
 * `apps/api/src/lib/slicing-jobs.ts`) matches that exact shape to decide whether to drop
 * incompatible builtin profiles and retry — changing the prefix silently disables that recovery.
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
  [-101]: 'The generated toolpaths collide. Try moving the prime tower further from the models.',
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
  return detail ? `${prefix}: ${detail}` : prefix
}
