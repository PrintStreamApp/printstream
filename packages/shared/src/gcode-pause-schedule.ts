/**
 * Recover a plate's pause schedule from the sliced G-code the printer is actually running.
 *
 * The fallback producer for {@link PrintPauseSchedule}: firmware that reports no `print.p_list`
 * tells us nothing about its pauses, but the file we dispatched states all of it exactly. This
 * module owns the reading of it and nothing else: the caller supplies the bytes, because the
 * two hosts that have them stream a ZIP entry very differently and neither concern belongs here
 * (same split as `gcode-header-times.ts` and `apps/slicer/src/gcode-header.ts`).
 *
 * ## Why position and layer come from different markers
 *
 * Both are stated in the file, and neither can be derived from the other:
 *
 * - **Position** comes from the `M73 P` in effect at the pause. That is the number the printer
 *   reports as `mc_percent`, and it is the elapsed-TIME fraction, so it cannot be computed from
 *   the layer index. See `print-pause-schedule.ts` for the measurements.
 * - **Layer** comes from counting `; CHANGE_LAYER`, the reserved tag the engine itself writes at
 *   every layer (`GCode.cpp:4622`). Verified against a real 375-layer plate: the running count
 *   equals the `M73 L<n>` on that layer at every single one. `M73 L` is NOT used as the source
 *   even though it agrees, because it lives in the machine's `layer_change_gcode` TEMPLATE and a
 *   profile that omits it would leave every pause unnumbered; the engine's tag cannot be omitted.
 *
 * Counting emitted layers is also what makes variable layer height a non-issue: nothing here
 * divides a height by a layer height, so an adaptive profile, a height-range modifier and a
 * thicker first layer all come out right for free. It is the reason this scans the body at all
 * rather than reading the 16 KB header the slicer already probes.
 *
 * ## What anchors a pause
 *
 * `; PAUSE_PRINTING`, which is `GCodeProcessor::ETags::Pause_Print`. The engine emits it
 * immediately before the expanded `machine_pause_gcode` (`GCode.cpp:4153`). Deliberately NOT
 * `M400 U1`: that is one machine's pause command, it appears in the config block of every file
 * whether or not the plate pauses, and `M400` alone appears hundreds of times as an ordinary wait.
 *
 * Every marker is matched against the WHOLE trimmed line. BambuStudio's config block writes each
 * setting as a single physical line with its newlines escaped (`; machine_pause_gcode = M400 U1`),
 * so a substring test would match the settings dump at the top of the file and place a pause at
 * layer zero of every print.
 */
import { MAX_PRINT_PAUSE_POINTS, type PrintPausePoint, type PrintPauseSchedule } from './print-pause-schedule.js'

const PAUSE_PRINT_TAG = '; PAUSE_PRINTING'
const LAYER_CHANGE_TAG = '; CHANGE_LAYER'
const TOTAL_LAYER_PREFIX = '; total layer number:'

/**
 * Longest run of bytes treated as one line. Real G-code lines are well under 200 characters; the
 * generous margin is for a long `; ..._gcode = ...` config value, which is one physical line with
 * its newlines escaped. See the flush in `push` for why an unbounded buffer is not acceptable.
 */
const MAX_SCANNED_LINE_LENGTH = 64 * 1024

export interface GcodePauseScanResult {
  points: PrintPausePoint[]
  /**
   * How many pauses the file states, which can exceed `points.length` on a plate carrying more
   * than {@link MAX_PRINT_PAUSE_POINTS}. This is the denominator, so it is deliberately NOT the
   * kept-points count.
   */
  totalPauses: number
  /**
   * The plate's layer count from `; total layer number:`, or null when the header did not state
   * one. It rides the schedule so the browser can cross-check it against the printer's live
   * `totalLayers`: a mismatch means the printer is running a different file than the one scanned,
   * and stale ticks are worse than none.
   */
  totalLayers: number | null
}

/**
 * Streaming scanner for one plate's G-code.
 *
 * Feed it the file in whatever chunks the transport produces and call {@link finish}. It holds a
 * single partial line between chunks and never buffers the file, because a sliced plate is
 * routinely hundreds of megabytes decompressed.
 */
export function createGcodePauseScanner() {
  let pending = ''
  let layer = 0
  let percent: number | null = null
  let remainingMinutes: number | null = null
  let totalLayers: number | null = null
  const points: PrintPausePoint[] = []
  /**
   * Every pause the file states, counted BEFORE the cap on how many are kept. This is the
   * denominator the user sees ("pause 2 of 3"), so capping it too would make a plate with more
   * pauses than the cap report "64 of 64" with sixteen still to come.
   */
  let seenPauses = 0

  function consumeLine(rawLine: string): void {
    const line = rawLine.trim()
    if (line === '') return

    if (line === LAYER_CHANGE_TAG) {
      layer += 1
      return
    }

    if (line === PAUSE_PRINT_TAG) {
      // A tag before the first layer change, or before the engine has emitted any progress, is
      // not something we can place on a bar. Drop it rather than pinning it to layer 0 / 0%.
      if (layer <= 0 || percent == null) return
      seenPauses += 1
      // A file carrying more pauses than a plate can bake was not authored here; recording the
      // first `MAX_PRINT_PAUSE_POINTS` is better than producing a schedule the wire schema
      // rejects (see the constant). The count above still advances, so the denominator stays true.
      if (points.length >= MAX_PRINT_PAUSE_POINTS) return
      points.push({
        index: seenPauses,
        layer,
        progressPercent: percent,
        remainingMinutes
      })
      return
    }

    if (line.startsWith(TOTAL_LAYER_PREFIX)) {
      const parsed = Number.parseInt(line.slice(TOTAL_LAYER_PREFIX.length).trim(), 10)
      if (Number.isFinite(parsed) && parsed > 0) totalLayers = parsed
      return
    }

    // Anchored on the command so the config block's `; xxx_gcode = ...M73...` lines cannot match.
    if (line.startsWith('M73 ')) {
      const percentMatch = /(?:^|\s)P(\d+(?:\.\d+)?)/.exec(line)
      if (percentMatch) {
        const parsed = Number.parseFloat(percentMatch[1]!)
        if (Number.isFinite(parsed)) percent = Math.max(0, Math.min(100, Math.round(parsed)))
      }
      const remainingMatch = /(?:^|\s)R(\d+(?:\.\d+)?)/.exec(line)
      if (remainingMatch) {
        const parsed = Number.parseFloat(remainingMatch[1]!)
        if (Number.isFinite(parsed)) remainingMinutes = Math.max(0, Math.round(parsed))
      }
    }
  }

  return {
    push(chunk: string): void {
      pending += chunk
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        consumeLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
      // Without this, an entry containing no newline at all (a binary or CR-only file, or a
      // crafted one) grows `pending` to the whole decompressed plate, which is exactly the
      // hundreds of megabytes the streaming design exists to avoid. Nothing this scanner matches
      // is anywhere near that long, so an over-long run cannot be a line it cares about: consume
      // it once, in case a real marker ends inside it, and start a fresh line.
      if (pending.length > MAX_SCANNED_LINE_LENGTH) {
        consumeLine(pending)
        pending = ''
      }
    },
    finish(): GcodePauseScanResult {
      if (pending !== '') {
        consumeLine(pending)
        pending = ''
      }
      return { points, totalPauses: seenPauses, totalLayers }
    }
  }
}

/** Convenience wrapper for callers that already hold the whole plate as text (tests, small files). */
export function scanGcodePauseSchedule(gcode: string): GcodePauseScanResult {
  const scanner = createGcodePauseScanner()
  scanner.push(gcode)
  return scanner.finish()
}

/**
 * Shape a completed scan as the wire contract.
 *
 * A scan that found nothing still produces a schedule, because "this plate has no pauses" is a
 * positive fact worth persisting. The distinction the UI depends on is between that and a null
 * schedule, which means nobody has established anything (see `print-pause-schedule.ts`), so a
 * caller whose scan FAILED must persist null rather than the empty result of a broken read.
 */
export function toPrintPauseSchedule(result: GcodePauseScanResult): PrintPauseSchedule {
  return {
    total: result.totalPauses,
    points: result.points,
    totalLayers: result.totalLayers,
    source: 'slicedFile'
  }
}
