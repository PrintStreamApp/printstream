/**
 * Turns a running print's pause schedule into what the progress bar shows: the ticks on the
 * track, and the one line of text beside it.
 *
 * The web-side adapter over `@printstream/shared`'s `print-pause-schedule.ts`, which owns the
 * rules (which producer wins, what counts as reached, how long until the next one). Nothing here
 * re-decides any of that; this module only chooses WORDING and which marks are worth drawing.
 *
 * Two things it is deliberately strict about:
 *
 * - **Unknown says nothing.** A print whose pauses we cannot establish renders no ticks AND no
 *   text. Both are absent together, because a bar with no ticks and no line reads as "nothing is
 *   claimed", while a line saying "no pauses" over an externally started print would be a claim
 *   we cannot support.
 * - **Only a RUNNING print gets marks.** The block that draws the bar is shared with dispatch
 *   uploads, slicing, queued jobs and finished history rows, where a pause tick would be
 *   meaningless or actively wrong. Callers pass the live status only for the two running-print
 *   surfaces (`PrinterCard`, `JobsView`'s active card).
 *
 * Counterparts: `components/ProgressBarMarkers.tsx` (draws them) and
 * `components/PrinterJobProgressBlock.tsx` (the slot).
 */
import {
  currentPrintPauseNumber,
  minutesUntilPrintPause,
  nextPrintPause,
  partitionPrintPauses,
  resolvePrintPauseSchedule,
  type PrintJob,
  type PrinterStatus
} from '@printstream/shared'
import type { ProgressBarMarker } from '../components/ProgressBarMarkers'
import { formatRemaining } from './printersViewHelpers'

/**
 * How many ticks are worth drawing. BambuStudio caps its own gauge at five
 * (`StatusPanel.cpp:1803`), and the reason holds harder here: these bars are ~120px on a phone,
 * so a plate with twenty pauses would draw a hatch pattern rather than information. Past the cap
 * the text line still names the next one, which is the part that reads on a small screen.
 */
const MAX_VISIBLE_PAUSE_MARKERS = 5

export interface PrintPauseMarkerView {
  markers: ProgressBarMarker[]
  /**
   * The single line under the bar, or null when there is nothing to say. Never "no pauses": see
   * the module header.
   */
  readout: string | null
}

const NOTHING: PrintPauseMarkerView = { markers: [], readout: null }

/**
 * Describe the pauses of the print a printer is running right now.
 *
 * `job` is the tracked `PrintJob` for that print, whose `pauseSchedule` is the fallback for
 * firmware that reports nothing itself. Pass it when the surface has one; a print started
 * outside PrintStream has none, and then only the printer's own report can say anything.
 */
export function buildPrintPauseMarkerView(
  status: Pick<PrinterStatus, 'pauseSchedule' | 'currentLayer' | 'totalLayers' | 'remainingMinutes' | 'stage'> | undefined,
  job: Pick<PrintJob, 'pauseSchedule'> | undefined
): PrintPauseMarkerView {
  if (!status) return NOTHING

  const schedule = resolvePrintPauseSchedule({
    printerSchedule: status.pauseSchedule,
    slicedFileSchedule: job?.pauseSchedule,
    reportedTotalLayers: status.totalLayers
  })
  if (!schedule || schedule.points.length === 0) return NOTHING

  const progress = {
    currentLayer: status.currentLayer,
    remainingMinutes: status.remainingMinutes
  }

  // Passed pauses keep their ticks: the bar is a picture of the whole print, and one vanishing as
  // the printer crosses it would look like the pause had been cancelled. But when there are more
  // pauses than the cap allows, the UPCOMING ones are the ones worth the pixels, because they are
  // the only ones the user can still act on. So the cap is spent on those first and any room left
  // over backfills with the most recent passed ones, nearest the fill edge.
  const { reached, upcoming } = partitionPrintPauses(schedule, progress)
  const shown = [
    ...reached.slice(Math.max(0, reached.length - Math.max(0, MAX_VISIBLE_PAUSE_MARKERS - upcoming.length))),
    ...upcoming.slice(0, MAX_VISIBLE_PAUSE_MARKERS)
  ]

  const markers = shown.map((point) => ({
    key: `pause-${point.index}`,
    percent: point.progressPercent,
    label: describePause(point.layer, minutesUntilPrintPause(point, progress))
  }))

  return { markers, readout: buildReadout(schedule, progress, status.stage) }
}

/**
 * Deliberately terse. The readout below the bar is the same sentence with a different opener, and
 * it lives in a fixed-width truncating row on the printer card: measured there, "about X away" ran
 * 230px into 214px of space and clipped the duration, which is the one part of the line the user
 * is actually reading. Without "about" the worst realistic case (a four-digit layer and a
 * multi-day estimate) measures 204px and fits.
 */
function describePause(layer: number, minutesAway: number | null): string {
  return minutesAway == null
    ? `Pause at layer ${layer}`
    : `Pause at layer ${layer}, ${formatRemaining(minutesAway)} away`
}

function buildReadout(
  schedule: NonNullable<ReturnType<typeof resolvePrintPauseSchedule>>,
  progress: Parameters<typeof nextPrintPause>[1],
  stage: PrinterStatus['stage']
): string | null {
  // While the printer is stopped, which pause it is stopped AT is the only useful thing to say,
  // and it is what the user is standing at the machine wondering. The stage label above already
  // says "Paused", so this does not repeat the word.
  if (stage === 'paused') {
    const at = currentPrintPauseNumber(schedule, progress)
    if (at != null) return `Pause ${at} of ${schedule.total}`
  }

  const next = nextPrintPause(schedule, progress)
  if (!next) return null

  const minutesAway = minutesUntilPrintPause(next, progress)
  // Same "X away" phrasing as the tick tooltip: the two sit within a few pixels of each other
  // under one bar, so wording the identical quantity two ways reads as two quantities.
  return minutesAway == null
    ? `Next pause: layer ${next.layer}`
    : `Next pause: layer ${next.layer}, ${formatRemaining(minutesAway)} away`
}
