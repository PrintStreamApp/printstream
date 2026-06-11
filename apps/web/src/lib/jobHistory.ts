import type { PrintJob } from '@printstream/shared'

/** Format the history subtitle for a completed print job. */
export function formatJobDispatchDetails(job: PrintJob): string {
  if (job.jobKind === 'calibration') return 'Calibration routine'
  if (job.jobKind === 'external') return 'Started outside PrintStream'

  const parts = [`Plate ${job.plate ?? 1}`]
  if (job.fileSizeBytes != null) parts.push(formatBytes(job.fileSizeBytes))
  return parts.join(' - ')
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}