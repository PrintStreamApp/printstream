/**
 * Starts calibration runs as tracked print jobs.
 */
import { startTrackedPrintJob } from './print-job-recorder.js'
import { printerManager } from './printer-manager.js'

export async function startCalibrationJob(input: {
  printerId: string
  printerName: string
  option: number
  jobId?: string
}): Promise<string | null> {
  const reservedJobId = input.jobId ?? `calibration:${Date.now()}`
  return await startTrackedPrintJob({
    jobId: reservedJobId,
    printerId: input.printerId,
    jobName: 'Calibration',
    fileName: 'Calibration',
    metadata: {
      jobKind: 'calibration',
      jobId: reservedJobId,
      taskId: reservedJobId,
      fileId: null,
      fileName: null,
      fileSizeBytes: null,
      sourceKind: null,
      plate: null,
      useAms: null,
      bedLevel: null,
      amsMapping: null,
      calibrationOption: input.option
    },
    publish: () => printerManager.publishCommand(input.printerId, {
      print: {
        command: 'calibration',
        option: input.option
      }
    })
  })
}