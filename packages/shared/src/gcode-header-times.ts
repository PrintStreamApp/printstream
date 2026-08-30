/**
 * BambuStudio's G-code header time line: what it says, and what it does NOT say.
 *
 * The engine emits one line near the top of every sliced file (`GCodeProcessor.cpp:709`):
 *
 *   ; model printing time: 4h 51m 5s; total estimated time: 4h 56m 29s
 *
 * and those two numbers are `machine.time - machine.prepare_time` and `machine.time`. So their
 * DIFFERENCE is the print's prepare phase (heating, bed levelling, calibration, purge), and it is
 * the only clean exposure of it: `machine.prepare_time` is never written to `result.json`, and the
 * per-plate `main_predication` there has the wipe-tower time folded in as well.
 *
 * OWNED HERE because two apps read this same line and there is a trap between them. `result.json`
 * has a top-level field also called `prepare_time`, and it is a completely different quantity:
 * `sliced_info.prepare_time = global_current_time - global_begin_time` (`BambuStudio.cpp:6201`),
 * the CLI's own wall clock in MILLISECONDS from process start to slice start. That measures the
 * machine running the slicer, not the print. Reading it as seconds put "2h 13m" of prepare time on
 * an 8-second load, next to a real 4h 56m print estimate, where it read as something the printer
 * was going to do. Same name, different unit, different subject; the check that separates them is
 * "does the number change when I slice the same file on a faster host?".
 *
 * Consumers: `apps/slicer/src/index.ts` (fills `estimatedPrepareTimeSeconds` from a finished
 * slice) and `apps/web/src/plugins/model-studio/lib/gcodePreview.ts` (normalises its own
 * move-by-move estimate against the engine's total).
 */

/**
 * Parse a BambuStudio header duration (`1d 2h 3m 4s`, `35m 21s`, `45s`) into seconds.
 *
 * Null when the text carries no recognizable unit at all, which is what separates "the header did
 * not state this" from a genuine zero.
 */
export function parseGcodeDuration(value: string): number | null {
  let seconds = 0
  let matched = false
  for (const match of value.matchAll(/(\d+)\s*([dhms])/gi)) {
    const amount = Number.parseInt(match[1]!, 10)
    if (!Number.isFinite(amount)) continue
    matched = true
    switch (match[2]!.toLowerCase()) {
      case 'd': seconds += amount * 86400; break
      case 'h': seconds += amount * 3600; break
      case 'm': seconds += amount * 60; break
      case 's': seconds += amount; break
    }
  }
  return matched ? seconds : null
}

export interface GcodeHeaderTimes {
  /** The engine's whole-print estimate (`machine.time`). */
  totalSeconds: number | null
  /** Printing only, prepare phase excluded (`machine.time - machine.prepare_time`). */
  modelPrintingSeconds: number | null
  /**
   * The prepare phase itself, i.e. the difference. Null unless BOTH halves were stated and the
   * subtraction is sane, because every other answer here is a fabrication: a PrusaSlicer-style
   * header states only a total, and inferring "then prepare is zero" would report a printer that
   * starts extruding the instant you press go.
   */
  prepareSeconds: number | null
}

/**
 * Read the time line out of a G-code header.
 *
 * Give it the first few KB of the file: the line sits in BambuStudio's `HEADER_BLOCK`, well before
 * the `CONFIG_BLOCK` and the moves, so nothing needs to read a 600k-line file to answer this.
 *
 * Also accepts the PrusaSlicer-lineage `; estimated printing time (normal mode) = ...` spelling for
 * the total, which older and foreign files carry. That form states no model-printing half, so it
 * yields a total with a null prepare rather than a guess.
 */
export function parseGcodeHeaderTimes(header: string): GcodeHeaderTimes {
  // Not anchored: Bambu puts the total mid-line, after the model time and a `;` separator. The
  // character class stops at that separator on its own.
  const totalMatch = /(?:total estimated time|estimated printing time(?:\s*\([^)]*\))?)\s*[:=]\s*([0-9dhms\s]+)/i.exec(header)
  const modelMatch = /model printing time\s*[:=]\s*([0-9dhms\s]+)/i.exec(header)

  const totalSeconds = totalMatch ? parseGcodeDuration(totalMatch[1]!) : null
  const modelPrintingSeconds = modelMatch ? parseGcodeDuration(modelMatch[1]!) : null

  let prepareSeconds: number | null = null
  if (totalSeconds != null && modelPrintingSeconds != null) {
    const difference = totalSeconds - modelPrintingSeconds
    // A negative difference means the two halves did not come from one slice (a concatenated file,
    // a header we half-matched). Report nothing rather than a number that cannot be true.
    if (difference >= 0) prepareSeconds = difference
  }

  return { totalSeconds, modelPrintingSeconds, prepareSeconds }
}
