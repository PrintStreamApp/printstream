/**
 * Owns fault-source freshness at the raw MQTT boundary, before status merging.
 * Missing/malformed fields are unknown, never clear. Unknown HMS codes participate
 * in reconciliation but are not newly recorded, matching the live parser's noise policy.
 */
import type { PrinterFaultSource } from '@printstream/shared'
import { formatHmsCode, formatPrintErrorCode, getHmsDeviceType, lookupHmsMessage } from './hms-codes.js'

export interface ObservedFaultCode {
  code: string
  message: string | null
}

export type FaultSourceObservation = Partial<Record<PrinterFaultSource, ObservedFaultCode[]>>

/** Valid uint32 values only: a corrupt source cannot establish an authoritative clear. */
function uint32(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number <= 0xffffffff ? number : null
}

/** Extract each source independently; a partial report says nothing about the other source. */
export function readFaultSourceObservation(report: unknown, serial: string): FaultSourceObservation {
  if (!report || typeof report !== 'object' || !('print' in report)) return {}
  const print = report.print
  if (!print || typeof print !== 'object') return {}
  const deviceType = getHmsDeviceType(serial)
  const observation: FaultSourceObservation = {}

  if ('hms' in print && Array.isArray(print.hms)) {
    const faults: ObservedFaultCode[] = []
    let valid = true
    for (const entry of print.hms) {
      if (!entry || typeof entry !== 'object') {
        valid = false
        break
      }
      const attr = uint32('attr' in entry ? entry.attr : 0)
      const value = uint32(entry.code)
      if (attr == null || value == null) {
        valid = false
        break
      }
      const code = formatHmsCode(attr, value)
      faults.push({ code, message: lookupHmsMessage(code, deviceType) })
    }
    if (valid) observation.hms = faults
  }

  if ('print_error' in print) {
    const value = uint32(print.print_error)
    if (value != null) {
      const code = formatPrintErrorCode(value)
      observation.device_error = value === 0 ? [] : [{ code, message: lookupHmsMessage(code, deviceType) }]
    }
  }
  return observation
}
