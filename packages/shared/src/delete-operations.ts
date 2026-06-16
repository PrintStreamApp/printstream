import { z } from 'zod'

export const deleteOperationKindSchema = z.enum([
  'library.delete',
  'printer.storage.delete'
])
export type DeleteOperationKind = z.infer<typeof deleteOperationKindSchema>

export const deleteOperationStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed'
])
export type DeleteOperationStatus = z.infer<typeof deleteOperationStatusSchema>

export const printerStorageDeleteEntrySchema = z.object({
  path: z.string().min(1),
  type: z.enum(['file', 'directory'])
})
export type PrinterStorageDeleteEntry = z.infer<typeof printerStorageDeleteEntrySchema>

export const startLibraryDeleteJobSchema = z.object({
  fileIds: z.array(z.string()).min(1)
})
export type StartLibraryDeleteJob = z.infer<typeof startLibraryDeleteJobSchema>

export const startPrinterStorageDeleteJobSchema = z.object({
  entries: z.array(printerStorageDeleteEntrySchema).min(1)
})
export type StartPrinterStorageDeleteJob = z.infer<typeof startPrinterStorageDeleteJobSchema>

export const deleteOperationJobSchema = z.object({
  id: z.string(),
  kind: deleteOperationKindSchema,
  targetName: z.string(),
  summaryLabel: z.string(),
  printerId: z.string().nullable(),
  status: deleteOperationStatusSchema,
  totalItems: z.number().int().positive(),
  completedItems: z.number().int().nonnegative(),
  progressPercent: z.number().min(0).max(100).nullable(),
  progressMessage: z.string(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable()
})
export type DeleteOperationJob = z.infer<typeof deleteOperationJobSchema>

export const deleteOperationsResponseSchema = z.object({
  jobs: z.array(deleteOperationJobSchema)
})
export type DeleteOperationsResponse = z.infer<typeof deleteOperationsResponseSchema>

export const deleteOperationResponseSchema = z.object({
  job: deleteOperationJobSchema
})
export type DeleteOperationResponse = z.infer<typeof deleteOperationResponseSchema>