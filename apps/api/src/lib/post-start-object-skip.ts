/**
 * One-shot, post-start object-skip FALLBACK for dispatched prints.
 *
 * The primary skip mechanism is the `skip_objects` array inside the
 * `project_file` print-start command (what Bambu Handy sends); recent firmware
 * honors it and reports the skipped instance ids back in status as
 * `print.s_obj`. Older firmware (no is_support_partskip) silently ignores the
 * start-command field, so callers that dispatch with deselected objects arm
 * this hook around the start command. Once the print-job recorder confirms the
 * tracked job is running (`print-job.started` carrying the caller's own job
 * id), the hook checks the printer's latest status: when every requested
 * identify_id is already in `skippedObjectIds` the firmware honored the
 * start-command skip and nothing is sent; otherwise (ids missing, or the
 * firmware never reports `s_obj`) the mid-print `skip_objects` command is
 * published exactly once for the full requested list. Either way the hook
 * disarms after its job starts. Matching on the tracked job id (not just the
 * printer) means an externally started or unrelated print can never trigger a
 * skip it does not own.
 *
 * A timeout backstop disarms the listener if the print never starts (upload
 * ok but the printer errored out, user cancelled on-device, etc.) so event
 * listeners never leak; the dispatcher also disarms explicitly when the start
 * command fails.
 */
import { commandToMqttPayloads } from './printer-command-payloads.js'
import { printerEvents, type PrinterEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'

/** How long an armed skip waits for its job to start before giving up. */
export const POST_START_SKIP_TIMEOUT_MS = 30 * 60 * 1000

export interface ArmPostStartObjectSkipInput {
  printerId: string
  printerModel: string
  /** The dispatch job id — also the tracked `PrintJob` id `print-job.started` reports. */
  dispatchJobId: string
  /** For log lines only. */
  jobName: string
  /** Instance `identify_id`s to skip (the id space `skip_objects` expects). */
  objectIds: number[]
  timeoutMs?: number
}

/**
 * Subscribe a one-shot `skip_objects` sender for a just-dispatched print.
 * Returns a disarm function (idempotent); the hook also disarms itself after
 * firing or after `timeoutMs`.
 */
export function armPostStartObjectSkip(input: ArmPostStartObjectSkipInput): () => void {
  const objectIds = [...new Set(input.objectIds)]
  if (objectIds.length === 0) return () => undefined

  let disarmed = false
  const disarm = (): void => {
    if (disarmed) return
    disarmed = true
    printerEvents.off('print-job.started', onJobStarted)
    clearTimeout(timer)
  }

  const onJobStarted: PrinterEvents['print-job.started'] = (event) => {
    if (event.jobId !== input.dispatchJobId || event.printer.id !== input.printerId) return
    disarm()
    // Firmware that accepted the start command's `skip_objects` reports the skipped
    // instance ids back as `s_obj`. When every requested id is already there, the
    // mid-print fallback is redundant — stand down. A null (never reported — older
    // firmware, or no state-bearing report yet) or incomplete list falls through to
    // the mid-print command for the full requested list; re-skipping an id the
    // firmware already skipped is harmless.
    const reportedSkippedIds = printerManager.getStatus(input.printerId)?.skippedObjectIds
    if (reportedSkippedIds && objectIds.every((id) => reportedSkippedIds.includes(id))) {
      console.log(`[dispatch] firmware honored start-command skip for ${objectIds.length} object(s) on printer ${input.printerId} ("${input.jobName}"); mid-print fallback not needed`)
      return
    }
    // Same payload construction as the manual skip in POST /api/printers/:id/command.
    const payloads = commandToMqttPayloads(
      input.printerModel,
      { type: 'skipObjects', objectIds },
      printerManager.getStatus(input.printerId)
    )
    let sent = false
    for (const payload of payloads) {
      if (printerManager.publishCommand(input.printerId, payload)) sent = true
    }
    if (sent) {
      console.log(`[dispatch] sent skip for ${objectIds.length} object(s) on printer ${input.printerId} ("${input.jobName}")`)
    } else {
      console.warn(`[dispatch] could not send skip for ${objectIds.length} object(s) on printer ${input.printerId} ("${input.jobName}"): printer not connected`)
    }
  }

  printerEvents.on('print-job.started', onJobStarted)
  const timer = setTimeout(() => {
    disarm()
    console.warn(`[dispatch] print "${input.jobName}" on printer ${input.printerId} never started; disarmed pending object skip`)
  }, input.timeoutMs ?? POST_START_SKIP_TIMEOUT_MS)
  timer.unref()

  console.log(`[dispatch] will skip ${objectIds.length} object(s) once "${input.jobName}" starts on printer ${input.printerId}`)
  return disarm
}
