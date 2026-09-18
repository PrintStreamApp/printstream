/**
 * Freshness gate for firmware's latest automatic PA measurement. A result is
 * readable only after this observer sees an active job finish without changing
 * task identity. The caller owns persistence and reports interruption as failure.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { isPrinterActiveJobStage, type PrinterStatus } from '@printstream/shared'
import { automaticPaResult, type AutomaticPaSetup } from './automatic-pa-protocol.js'

interface Observation {
  status(): PrinterStatus | undefined
  result(): Promise<Record<string, unknown>>
  signal: AbortSignal
  /** Injectable clock and wait keep deadline tests independent of wall time. */
  now?: () => number
  wait?: () => Promise<void>
}

/** Return a fresh matching K/N pair, or reject on cancellation, disconnect or deadline. */
export async function observeAutomaticPa(setup: AutomaticPaSetup, nozzleDiameter: string, observation: Observation): Promise<{ k: number; n: number }> {
  const now = observation.now ?? Date.now
  const wait = observation.wait ?? (() => delay(2000, undefined, { signal: observation.signal }))
  const started = now()
  let sawActive = false
  let taskId: string | null = null
  let finishedAt: number | null = null

  while (true) {
    observation.signal.throwIfAborted()
    const status = observation.status()
    if (!status?.online) throw new Error('Printer disconnected during calibration. Run it again for a fresh result.')
    if (status.stage === 'failed') throw new Error('Calibration was cancelled or failed on the printer')
    if (taskId && status.taskId && taskId !== status.taskId) throw new Error('The printer started a different job during calibration')
    if (isPrinterActiveJobStage(status.stage)) {
      sawActive = true
      taskId ??= status.taskId
    }
    if (now() - started > 30 * 60_000) throw new Error('Automatic calibration timed out')
    if (!sawActive && now() - started > 90_000) throw new Error('The printer did not report the calibration starting')
    if (sawActive && status.stage === 'finished') {
      finishedAt ??= now()
      const reply = await observation.result()
      observation.signal.throwIfAborted()
      // A result request can take seconds. Do not adopt firmware's latest value
      // if another job started while its reply was in flight.
      const afterReply = observation.status()
      if (!afterReply?.online || afterReply.stage !== 'finished'
        || (taskId && afterReply.taskId && taskId !== afterReply.taskId)) {
        throw new Error('The printer changed jobs while returning the calibration measurement')
      }
      const result = automaticPaResult(reply, setup, nozzleDiameter)
      if (result) return result
      if (now() - finishedAt > 60_000) throw new Error('The printer did not return a matching calibration measurement')
    }
    await wait()
  }
}
