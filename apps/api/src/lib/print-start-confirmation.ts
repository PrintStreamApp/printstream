/**
 * Waits for the printer to confirm a dispatched start command.
 *
 * Owns the one question the dispatcher cannot answer itself: did the printer actually start?
 * Publishing returns as soon as the command is handed to the bridge's socket, and nothing on
 * that path hears back from the printer. Worse, P1-series firmware has been reported to reply
 * `result: success` to `project_file` and still never start (Home Assistant community, Oct
 * 2023, https://community.home-assistant.io/t/bambu-lab-x1-x1c-mqtt/489510?page=35 : the
 * workaround there was a pause between the FTP upload and the command), so even a
 * reply would not prove it. The only evidence is the printer's own status, which the print-job
 * recorder (`print-job-recorder.ts`, the counterpart) already watches and turns into at most one
 * of two events for the tracked job id:
 *
 * - `print-job.started`: the printer left its terminal stage within the start grace.
 * - `print-job.start-unconfirmed`: it was still reporting a terminal stage once the grace ran out.
 *
 * Neither fires while the printer is offline or silent, so a backstop timer ends the wait as
 * `unknown` instead: "could not confirm" is a different claim from "did not start", and only the
 * second justifies telling the user the print failed.
 *
 * Contract: `onOutcome` is called at most once, and never after `dispose()`. Subscribe BEFORE
 * publishing the start command, so a fast printer cannot confirm in the gap.
 */
import { printerEvents } from './printer-events.js'

/** How a start command ended, from the printer's side. */
export type PrintStartOutcome = 'started' | 'not-started' | 'unknown'

/**
 * Longest wait for either recorder event, in ms. Comfortably past the recorder's 60s grace plus
 * the gap until the printer's next report (the bridge requests a full report every 30s).
 */
export const PRINT_START_CONFIRMATION_BACKSTOP_MS = 5 * 60_000

/**
 * Watch for the printer's verdict on the start of tracked job `jobId`.
 *
 * Returns `dispose`, which stops listening without reporting anything (the caller is ending the
 * wait for its own reason, e.g. the start command was never sent, or the server is stopping).
 */
export function watchPrintStartConfirmation(input: {
  jobId: string
  onOutcome: (outcome: PrintStartOutcome) => void
  backstopMs?: number
}): () => void {
  let settled = false

  const settle = (outcome: PrintStartOutcome | null): void => {
    if (settled) return
    settled = true
    clearTimeout(backstop)
    printerEvents.off('print-job.started', onStarted)
    printerEvents.off('print-job.start-unconfirmed', onUnconfirmed)
    if (outcome) input.onOutcome(outcome)
  }

  const onStarted = (event: { jobId: string }): void => {
    if (event.jobId === input.jobId) settle('started')
  }
  const onUnconfirmed = (event: { jobId: string }): void => {
    if (event.jobId === input.jobId) settle('not-started')
  }

  printerEvents.on('print-job.started', onStarted)
  printerEvents.on('print-job.start-unconfirmed', onUnconfirmed)
  const backstop = setTimeout(() => settle('unknown'), input.backstopMs ?? PRINT_START_CONFIRMATION_BACKSTOP_MS)
  // A pending confirmation must never hold the process open on shutdown.
  backstop.unref?.()

  return () => settle(null)
}
