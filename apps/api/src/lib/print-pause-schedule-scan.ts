/**
 * The fallback producer for a running print's pause markers: read them out of the G-code we
 * dispatched, for printers whose firmware publishes no `print.p_list`.
 *
 * OWNS the Node half only. Which lines mean what is `@printstream/shared`'s
 * `gcode-pause-schedule.ts`, shared so it can be tested from plain strings; this module owns
 * resolving which ZIP entry to read and getting the result onto the `PrintJob` row the browser
 * reads it back from.
 *
 * CONTRACT: every export here is **best-effort and never fails the print**. A schedule is a
 * decoration on a progress bar; a dispatch that succeeded must not be reported as failed because
 * a 300 MB entry could not be re-read, so {@link recordDispatchedPrintPauseSchedule} swallows and
 * logs everything and is deliberately called without `await`.
 *
 * WHY IT RUNS AT DISPATCH rather than at slice time: dispatch is the one point that holds the
 * exact bytes going to the printer. A library file moves on after a slice (the prepare-print
 * dialog adds and removes pauses per-slice without persisting them), so a schedule derived from
 * the file's current head would describe pauses this print does not have. Same rule as the
 * editor's base bytes: resolve from what was sent, never from the head. It also means a
 * pre-sliced `.gcode.3mf` a user uploaded gets markers on exactly the same code path as one we
 * sliced, with nothing extra to build.
 *
 * Counterparts: `print-dispatcher.ts` (the caller), `routes/jobs.ts` (reads the column back onto
 * the DTO), and `bambu-report-parser.ts` (the preferred producer, which wins whenever it has
 * anything to say).
 */
import {
  buildPlateGcodeFileHint,
  createGcodePauseScanner,
  printPauseScheduleSchema,
  toPrintPauseSchedule,
  type PrintPauseSchedule
} from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { streamEntryText } from './three-mf-internal.js'
import { broadcastJobsChanged } from './ws-resource-events.js'

/**
 * Ceiling on the decompressed plate G-code this will read.
 *
 * Generous, because a sliced plate really is routinely hundreds of megabytes, but not unbounded:
 * the entry comes from a user-supplied archive whose central directory can under-declare its
 * uncompressed size, and this runs detached with nothing watching it. A file past the cap simply
 * yields no schedule, which the UI already renders as "unknown".
 */
const MAX_SCANNED_PLATE_BYTES = 1024 * 1024 * 1024

/**
 * Scan the plate G-code inside a dispatched `.gcode.3mf`.
 *
 * Returns null when the archive holds no such plate entry, which is the ordinary answer for a
 * `.3mf` that was never sliced and for a plate index that does not match this artifact. Null is
 * "we know nothing", and the browser renders it as silence rather than as "no pauses", so a
 * failed read must reach the caller as null and never as an empty schedule.
 */
export async function scanDispatchedPrintPauseSchedule(input: {
  localPath: string
  plate: number | null
}): Promise<PrintPauseSchedule | null> {
  const entryPath = buildPlateGcodeFileHint(input.plate)
  if (!entryPath) return null

  const scanner = createGcodePauseScanner()
  const found = await streamEntryText(input.localPath, entryPath, (chunk) => scanner.push(chunk), {
    maxBytes: MAX_SCANNED_PLATE_BYTES
  })
  if (!found) return null

  return toPrintPauseSchedule(scanner.finish())
}

/**
 * Scan a dispatch's artifact and store the result against its print job.
 *
 * Fire-and-forget by design: call it without awaiting, straight after the start command lands.
 * The schedule is not needed until the printer reports a layer, which is many seconds away, so
 * paying for the scan before the start command would add latency to every print for a decoration.
 *
 * The row is updated only if it still exists and has no schedule: a printer that publishes
 * `p_list` makes this redundant, and a re-dispatch onto the same job id should not have two scans
 * racing to write different answers.
 *
 * Two things this has to do that are easy to leave out, because without either one the whole
 * fallback producer is invisible on exactly the firmware it exists for:
 *
 * - **It announces itself.** Every other jobs write broadcasts `resource.changed{jobs}`, which is
 *   what invalidates the browser's `['jobs']` query. Landing this row silently meant the schedule
 *   was only ever picked up if the scan happened to finish before the printer reported the job
 *   started, and was lost for the whole print if it did not.
 * - **It writes through `rootPrisma`.** `PrintJob` is workspace-scoped and this runs detached from
 *   any request, so the scoped client has no `AsyncLocalStorage` context: it would log a warning
 *   and fall through unscoped in dev, or, if a stale context did survive, scope the update to the
 *   wrong workspace and match nothing. Same reason `print-job-recorder.ts` uses it throughout.
 */
export async function recordDispatchedPrintPauseSchedule(input: {
  printJobId: string
  localPath: string | null
  plate: number | null
}): Promise<void> {
  if (!input.localPath) return
  try {
    const schedule = await scanDispatchedPrintPauseSchedule({
      localPath: input.localPath,
      plate: input.plate
    })
    if (!schedule) return
    const { count } = await rootPrisma.printJob.updateMany({
      where: { id: input.printJobId, pauseScheduleJson: null },
      data: { pauseScheduleJson: JSON.stringify(schedule) }
    })
    if (count === 0) return

    const row = await rootPrisma.printJob.findUnique({
      where: { id: input.printJobId },
      select: { workspaceId: true }
    })
    broadcastJobsChanged(row?.workspaceId ?? null)
  } catch (error) {
    console.warn(
      `[pause-schedule] could not scan pauses for job ${input.printJobId}`,
      (error as Error).message
    )
  }
}

/**
 * Read `PrintJob.pauseScheduleJson` back into the wire contract, for the jobs DTO.
 *
 * The counterpart to what {@link recordDispatchedPrintPauseSchedule} writes, and kept beside it
 * so one module owns both halves of the column's format.
 *
 * Anything unparseable reads as null rather than throwing, and deliberately logs nothing. Null is
 * already the value every reader handles (it renders as "unknown"), one bad row is not worth
 * failing a whole jobs listing over, and this runs per row on `GET /api/jobs`, which every jobs
 * invalidation refetches: a warn here would repeat for the same row on every poll for as long as
 * the row exists. The write side is where a genuine failure is reported.
 *
 * Takes the column as `unknown` because the jobs route reaches it through both a typed Prisma
 * select and a raw legacy query, and the latter types every column loosely.
 */
export function readRecordedPrintPauseSchedule(row: {
  pauseScheduleJson?: unknown
}): PrintPauseSchedule | null {
  const raw = row.pauseScheduleJson
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = printPauseScheduleSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
