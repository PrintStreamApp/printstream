/**
 * Where a running print's baked pauses sit ON THE PROGRESS BAR, and which one is next.
 *
 * Owns the wire shape both producers fill and the ONE set of rules every surface reads it
 * through, so a tick, its tooltip, the "next pause" line and the "pause 2 of 3" counter can
 * never disagree about which pauses are behind the printer and which are ahead.
 *
 * ## The invariant that makes a tick placeable: percent, not layers
 *
 * A marker has to sit on the same scale the fill uses, and that scale is TIME, not layers.
 * `PrinterStatus.progressPercent` is Bambu's `mc_percent`, which comes from the sliced file's
 * `M73 P`, which BambuStudio computes as `100 * elapsed_time / machine.time`
 * (`GCodeProcessor.cpp:822`): the time estimator's elapsed fraction. Nothing about layer index
 * or file offset enters it. Measured against real sliced plates, placing a marker at
 * `layer / totalLayers` instead lands up to 19 points out on an ordinary plate and 41 points out
 * on one with a slow bottom (layer 35 of 282 reads 53%, not 12%).
 *
 * So {@link PrintPausePoint.progressPercent} is carried explicitly and is never derived from
 * `layer / totalLayers` by any caller. `layer` is for TELLING the user which layer it is; only
 * `progressPercent` positions anything.
 *
 * ## Two producers, one shape
 *
 * - `printer`: the printer's own `print.p_list`, the field BambuStudio 2.8.2 draws its gauge
 *   markers from (`DeviceCore/DevPrintTaskInfo.cpp`). Authoritative and available even for a
 *   print nobody started from here (Studio, Handy, an SD card).
 * - `slicedFile`: scanned out of the g-code we dispatched (`gcode-pause-schedule.ts`), for
 *   firmware that reports no `p_list`.
 *
 * {@link resolvePrintPauseSchedule} picks between them. Producers disagreeing is worth being
 * able to see, which is why `source` rides the wire even though no user-facing string mentions it.
 *
 * ## Unknown is not "no pauses"
 *
 * A null schedule means we do not know, and every surface must then say nothing at all rather
 * than implying the print runs straight through. A schedule with `points: []` is the positive
 * statement that there are none. Do not collapse the two.
 *
 * Counterpart surfaces: `apps/web/src/components/PrinterJobProgressBlock.tsx` (the ticks) and
 * `apps/web/src/lib/printPauseMarkers.ts` (the readout copy).
 */
import { z } from 'zod'

/**
 * Ceiling on points in one schedule, matching `sceneEditPlatePausesSchema`'s own cap on how many
 * pauses a plate can bake.
 *
 * Every producer must apply it, not just respect it by luck. `printPauseScheduleSchema` is part
 * of `PrinterStatus`, so a status frame carrying an over-long schedule fails `wsEventSchema` in
 * the browser and the whole frame is dropped: temps, progress, stage and AMS all freeze on stale
 * data for as long as that print runs. The blast radius of getting this wrong is the entire
 * printer card, not the markers.
 */
export const MAX_PRINT_PAUSE_POINTS = 64

export const printPausePointSchema = z.object({
  /**
   * 1-based position along the print, and the number the user is shown as "pause 2 of 3".
   *
   * Producers ASSIGN this from print order; they do not copy the printer's `p_list[].i`. Whether
   * that field is 0- or 1-based cannot be established from BambuStudio's source (its only reader,
   * `DevPrintPauseList::getPassedCount`, is documented as "how many pause points precede the next
   * pending pause" while returning the minimum `i` outright, which only holds if `i` is 0-based),
   * and no firmware has been available to settle it. Deriving the number we display means the
   * answer does not matter: getting it wrong would have shifted one label by one, and trusting it
   * as a 1-based value would have made a 0-based `i` reject every frame.
   */
  index: z.number().int().positive(),
  /**
   * The layer number the printer reports (`PrinterStatus.currentLayer`) while it is stopped
   * here. The engine emits the pause AFTER the layer change (`GCode.cpp:4689` then `:4806`),
   * so this is the layer whose top is the authored pause height, not the one below it.
   */
  layer: z.number().int().positive(),
  /**
   * Where the tick goes: the value `PrinterStatus.progressPercent` will report at this pause,
   * on the same 0-100 time-linear scale. See the module header for why this cannot be derived
   * from `layer`.
   */
  progressPercent: z.number().int().min(0).max(100),
  /**
   * Minutes the printer will report as remaining when it reaches this pause, i.e. the same
   * quantity as `PrinterStatus.remainingMinutes`. Time-until-pause is the difference between
   * the two, which is how BambuStudio labels its own markers (`StatusPanel.cpp:1823`).
   *
   * Null when the producer could not state one. Firmware uses a NEGATIVE `t` for that, which
   * Studio filters out before drawing (`StatusPanel.cpp:1809` requires `>= 0`), so clamping it
   * to zero here would turn "I cannot time this" into "it is due now" and let every readout
   * quote a duration nobody computed. Unmeasurable is not zero, the same rule
   * `slot-remaining.ts` holds for a spool the printer cannot weigh.
   */
  remainingMinutes: z.number().int().nonnegative().nullable().default(null)
})
export type PrintPausePoint = z.infer<typeof printPausePointSchema>

export const printPauseScheduleSchema = z.object({
  /**
   * How many pauses the plate has in total. Kept separate from `points.length` because the
   * printer reports a total alongside a list it may have already trimmed as pauses were
   * consumed, and "pause 2 of 3" needs the original denominator.
   */
  total: z.number().int().nonnegative(),
  points: z.array(printPausePointSchema).max(MAX_PRINT_PAUSE_POINTS),
  /**
   * Layer count of the file this schedule describes, when the producer knows it. Only the
   * `slicedFile` producer fills it, and only so {@link resolvePrintPauseSchedule} can refuse a
   * schedule scanned from a file the printer is not running (see there). The printer's own list
   * needs no such check and leaves this null.
   */
  totalLayers: z.number().int().positive().nullable().default(null),
  /** Which producer filled this in. Diagnostic only; never rendered. */
  source: z.enum(['printer', 'slicedFile'])
})
export type PrintPauseSchedule = z.infer<typeof printPauseScheduleSchema>

/**
 * Pick the schedule to render for a running print.
 *
 * The printer's own list wins whenever it has one: it describes the file the printer is
 * genuinely running, so it cannot be stale against a re-dispatch or a library file that has
 * moved on, and it is the only source that says anything at all about a print started outside
 * PrintStream. The scanned-file list is the fallback for firmware that reports no `p_list`.
 *
 * The fallback is admitted only once its layer count has been matched against the layer count
 * the printer reports. A job row records the file we DISPATCHED, and the printer may be running
 * something else entirely (an SD-card start, a job re-sent by hand, a queue that moved on), in
 * which case every scanned tick is in the wrong place, which is worse than no ticks at all.
 *
 * Two things the check deliberately does NOT do, because each would silently disable the whole
 * fallback rather than merely allow a bad case:
 *
 * - It does not demand an exact match. The two numbers come from different places (the file's
 *   `; total layer number:` header versus the printer's `total_layer_num`), and no firmware has
 *   been observed here to confirm they agree to the layer. A single-layer disagreement is a
 *   counting convention; a different file differs by far more than that.
 * - It does not reject on a missing number. A schedule that states no layer count, or a printer
 *   that has not reported one yet, is left unchecked, or the feature would be invisible on every
 *   print until its first layer lands.
 *
 * Returns null when neither producer has anything, which callers must render as silence rather
 * than as "no pauses" (see the module header).
 */
export function resolvePrintPauseSchedule(input: {
  printerSchedule?: PrintPauseSchedule | null
  slicedFileSchedule?: PrintPauseSchedule | null
  /** The printer's live `totalLayers`, used only to vet the scanned-file fallback. */
  reportedTotalLayers?: number | null
}): PrintPauseSchedule | null {
  if (input.printerSchedule) return input.printerSchedule

  const fallback = input.slicedFileSchedule
  if (!fallback) return null

  const reported = input.reportedTotalLayers
  const scanned = fallback.totalLayers
  if (reported != null && reported > 0 && scanned != null && Math.abs(scanned - reported) > 1) {
    return null
  }
  return fallback
}

/**
 * The live position a pause schedule is read against. A subset of `PrinterStatus`.
 *
 * Note what is NOT here: `progressPercent`. A pause's own percent is what places its tick, but
 * nothing grades a pause against the printer's current percent, because that number moves
 * whenever the printer re-estimates and would make pauses appear to be reached and un-reached.
 * Every judgement below is on the layer, which only ever counts up.
 */
export interface PrintPauseProgress {
  currentLayer: number | null
  remainingMinutes: number | null
}

/**
 * Split a schedule into the pauses the printer has passed and the ones still ahead.
 *
 * Graded on LAYER rather than percent or remaining time, because the layer is a whole number the
 * printer reports directly and it does not move backwards when the printer re-estimates how long
 * it has left. A pause on the layer the printer is currently on counts as reached, not upcoming:
 * the engine emits the pause immediately after that layer change, so by the time the printer
 * reports the layer it is already stopped there (or about to be).
 *
 * With no layer reported, nothing can be graded and everything is reported as upcoming, which is
 * the harmless direction: the bar still draws every tick, and the "next pause" readout is the
 * first one rather than a wrong one.
 */
export function partitionPrintPauses(
  schedule: PrintPauseSchedule,
  progress: PrintPauseProgress
): { reached: PrintPausePoint[]; upcoming: PrintPausePoint[] } {
  const ordered = [...schedule.points].sort((a, b) => a.index - b.index)
  const currentLayer = progress.currentLayer
  if (currentLayer == null || currentLayer <= 0) return { reached: [], upcoming: ordered }

  const reached: PrintPausePoint[] = []
  const upcoming: PrintPausePoint[] = []
  for (const point of ordered) {
    if (point.layer <= currentLayer) reached.push(point)
    else upcoming.push(point)
  }
  return { reached, upcoming }
}

/** The next pause the print will hit, or null when none remain (or none exist). */
export function nextPrintPause(
  schedule: PrintPauseSchedule,
  progress: PrintPauseProgress
): PrintPausePoint | null {
  return partitionPrintPauses(schedule, progress).upcoming[0] ?? null
}

/**
 * Minutes until the printer reaches `point`, or null when it cannot be stated.
 *
 * Both numbers are "minutes the printer expects to still be printing", so the difference is the
 * gap between them, the same subtraction BambuStudio labels its markers with. A non-positive
 * result means the printer has already passed the pause (or its estimate has drifted past it),
 * and reports null rather than "0 min", which would read as "any moment now".
 */
export function minutesUntilPrintPause(
  point: PrintPausePoint,
  progress: PrintPauseProgress
): number | null {
  const remaining = progress.remainingMinutes
  if (remaining == null || point.remainingMinutes == null) return null
  const minutes = remaining - point.remainingMinutes
  return minutes > 0 ? minutes : null
}

/**
 * Which pause the printer is sitting at right now, 1-based, or null when it is not at one.
 *
 * Deliberately does NOT test the printer's stage: a caller that already knows the printer is
 * paused asks this for the number, and a caller that does not should be asking
 * {@link nextPrintPause} instead. Keeping the stage test out of here stops this function from
 * needing to know the three different sub-stage codes a Bambu pause can report.
 */
export function currentPrintPauseNumber(
  schedule: PrintPauseSchedule,
  progress: PrintPauseProgress
): number | null {
  const { reached } = partitionPrintPauses(schedule, progress)
  const at = reached.at(-1)
  return at && at.layer === progress.currentLayer ? at.index : null
}
