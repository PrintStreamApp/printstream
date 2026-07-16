/**
 * Pairs each dispatch-queue job (see `jobsDispatchQueue.ts`) with its resolved
 * `PrintJob` history row when one exists, so the queue UI can show a dispatch
 * item's underlying print (progress, result) alongside its upload state.
 */
import type { PrintDispatchJob, PrintJob } from '@printstream/shared'
import { isActiveDispatchJob } from './dispatchToastVisibility'
import { selectDispatchQueueJobs } from './jobsDispatchQueue'

export interface LinkedDispatchJob {
  dispatchJob: PrintDispatchJob
  printJob: PrintJob | null
}

export function selectDispatchQueueWithPrintJobs(
  printJobs: readonly PrintJob[],
  dispatchJobs: readonly PrintDispatchJob[]
): LinkedDispatchJob[] {
  const printJobsById = indexPrintJobsById(printJobs)
  return selectDispatchQueueJobs(dispatchJobs).map((dispatchJob) => ({
    dispatchJob,
    printJob: printJobsById.get(dispatchJob.printJobId) ?? null
  }))
}

export function mapActiveDispatchJobsByPrinter(
  printJobs: readonly PrintJob[],
  dispatchJobs: readonly PrintDispatchJob[]
): Map<string, LinkedDispatchJob> {
  const printJobsById = indexPrintJobsById(printJobs)
  const activeDispatchJobs = new Map<string, LinkedDispatchJob>()
  for (const dispatchJob of dispatchJobs) {
    if (!isActiveDispatchJob(dispatchJob)) continue
    if (activeDispatchJobs.has(dispatchJob.printerId)) continue
    activeDispatchJobs.set(dispatchJob.printerId, {
      dispatchJob,
      printJob: printJobsById.get(dispatchJob.printJobId) ?? null
    })
  }
  return activeDispatchJobs
}

export function mapLatestFinishedPrintJobsByPrinter(printJobs: readonly PrintJob[]): Map<string, PrintJob> {
  const latestFinishedJobs = new Map<string, PrintJob>()
  for (const printJob of printJobs) {
    if (!printJob.finishedAt) continue
    if (!latestFinishedJobs.has(printJob.printerId)) {
      latestFinishedJobs.set(printJob.printerId, printJob)
    }
  }
  return latestFinishedJobs
}

export function mapLatestActivePrintJobsByPrinter(printJobs: readonly PrintJob[]): Map<string, PrintJob> {
  const latestActiveJobs = new Map<string, PrintJob>()
  for (const printJob of printJobs) {
    if (printJob.finishedAt) continue
    if (!latestActiveJobs.has(printJob.printerId)) {
      latestActiveJobs.set(printJob.printerId, printJob)
    }
  }
  return latestActiveJobs
}

function indexPrintJobsById(printJobs: readonly PrintJob[]): Map<string, PrintJob> {
  return new Map(printJobs.map((printJob) => [printJob.id, printJob]))
}