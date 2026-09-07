import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Printer, PrinterStatus } from '@printstream/shared'
import { makeOfflineStatus } from './bambu-report-parser.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'

interface ManagedEntry {
  printer: Printer
  status: PrinterStatus
  lastStage?: PrinterStatus['stage']
  lastJobName?: string | null
}

const printerManagerState = printerManager as unknown as {
  managed: Map<string, ManagedEntry>
  applyStatusDelta: (entry: ManagedEntry, delta: Partial<PrinterStatus>) => PrinterStatus
}

afterEach(() => {
  printerManagerState.managed.clear()
})

function makePrinter(): Printer {
  return {
    id: 'printer-1',
    name: 'Home',
    host: '192.168.0.10',
    serial: '0948AD590900302',
    accessCode: 'secret',
    model: 'H2D',
    currentPlateType: null,
    currentNozzleDiameters: [],
    position: 0,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z'
  }
}

/** Drive a printing -> FAILED transition and return the emitted job result. */
function endPrintWith(deviceError: PrinterStatus['deviceError']): string | undefined {
  const printer = makePrinter()
  const entry: ManagedEntry = {
    printer,
    status: { ...makeOfflineStatus(printer), online: true, stage: 'printing', jobName: 'Best Shot Golf' },
    lastStage: 'printing',
    lastJobName: 'Best Shot Golf'
  }
  printerManagerState.managed.set(printer.id, entry)

  let result: string | undefined
  // Registered and removed per call rather than cleared in `afterEach`: the real
  // recorder and notification listeners share this bus, so a blanket
  // `removeAllListeners` would silently unhook them for the rest of the process.
  const capture = (event: { result: string }) => {
    result = event.result
  }
  printerEvents.on('job.finished', capture)
  try {
    printerManagerState.applyStatusDelta(entry, { stage: 'failed', deviceError })
  } finally {
    printerEvents.off('job.finished', capture)
  }
  return result
}

test('a print the printer reports as cancelled finishes as cancelled, not failed', () => {
  // Bambu marks a cancellation the same way it marks a jam: gcode_state FAILED
  // plus a print_error. Deriving the result from the stage alone recorded every
  // cancelled print as Failed and sent the error-level "Print failed" notification.
  assert.equal(endPrintWith({ code: '0300400C', message: 'The task was canceled.' }), 'cancelled')
  assert.equal(endPrintWith({ code: '0500400E', message: 'Printing was cancelled.' }), 'cancelled')
})

test('a genuine failure still finishes as failed', () => {
  assert.equal(endPrintWith({ code: '0C008043', message: 'Nozzle clumping detected' }), 'failed')
  assert.equal(endPrintWith(null), 'failed')
})
