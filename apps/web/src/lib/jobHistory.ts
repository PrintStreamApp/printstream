import { formatBytes, type PrintJob } from '@printstream/shared'

/** Format the history subtitle for a completed print job. */
export function formatJobDispatchDetails(job: PrintJob): string {
  if (job.jobKind === 'calibration') return 'Calibration routine'
  if (job.jobKind === 'external') return 'Started outside PrintStream'

  const parts = [`Plate ${job.plate ?? 1}`]
  if (job.fileSizeBytes != null) parts.push(formatBytes(job.fileSizeBytes))
  return parts.join(' - ')
}