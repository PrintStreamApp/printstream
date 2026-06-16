/**
 * Order and order-template contracts shared by the API and web client: reusable
 * print templates (variants and their library-file items), orders instantiated
 * from them, per-order print items with their dispatch/activity state, and
 * progress rollups.
 */
import { z } from 'zod'
import { printFromLibrarySchema, threeMfProjectFilamentSchema } from './printer.js'

const shortTextSchema = z.string().trim().min(1).max(160)
const optionalCodeSchema = z.string().trim().min(1).max(80).nullable()
const optionalLongTextSchema = z.string().trim().max(4_000).nullable()
const optionalItemNotesSchema = z.string().trim().max(1_000).nullable()

export const orderStatusSchema = z.enum(['active', 'completed'])
export type OrderStatus = z.infer<typeof orderStatusSchema>

export const orderPrintStatusSchema = z.enum(['pending', 'started', 'completed'])
export type OrderPrintStatus = z.infer<typeof orderPrintStatusSchema>

export const orderPrintCompletionSourceSchema = z.enum(['confirmed', 'manual'])
export type OrderPrintCompletionSource = z.infer<typeof orderPrintCompletionSourceSchema>

export const orderPrintActivityStateSchema = z.enum([
  'pending',
  'queued',
  'printing',
  'awaiting-confirmation',
  'failed',
  'cancelled',
  'completed'
])
export type OrderPrintActivityState = z.infer<typeof orderPrintActivityStateSchema>

export const orderTemplatePrintInputSchema = z.object({
  libraryFileId: z.string().min(1),
  plate: z.number().int().positive(),
  quantity: z.number().int().positive().max(999),
  notes: optionalItemNotesSchema.optional()
})
export type OrderTemplatePrintInput = z.infer<typeof orderTemplatePrintInputSchema>

export const orderTemplateVariantInputSchema = z.object({
  name: shortTextSchema,
  items: z.array(orderTemplatePrintInputSchema).min(1).max(200)
})
export type OrderTemplateVariantInput = z.infer<typeof orderTemplateVariantInputSchema>

export const orderTemplateCreateSchema = z.object({
  name: shortTextSchema,
  code: optionalCodeSchema.optional(),
  description: optionalLongTextSchema.optional(),
  notesTemplate: optionalLongTextSchema.optional(),
  variants: z.array(orderTemplateVariantInputSchema).min(1).max(25)
})
export type OrderTemplateCreateInput = z.infer<typeof orderTemplateCreateSchema>

export const orderTemplateUpdateSchema = z.object({
  name: shortTextSchema.optional(),
  code: optionalCodeSchema.optional(),
  description: optionalLongTextSchema.optional(),
  notesTemplate: optionalLongTextSchema.optional(),
  variants: z.array(orderTemplateVariantInputSchema).min(1).max(25).optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: 'Provide at least one field to update'
})
export type OrderTemplateUpdateInput = z.infer<typeof orderTemplateUpdateSchema>

export const orderTemplatePrintSchema = z.object({
  id: z.string(),
  libraryFileId: z.string().nullable(),
  libraryFileName: z.string(),
  plate: z.number().int().positive(),
  quantity: z.number().int().positive(),
  notes: optionalItemNotesSchema,
  position: z.number().int().nonnegative(),
  fileAvailable: z.boolean()
})
export type OrderTemplatePrint = z.infer<typeof orderTemplatePrintSchema>

export const orderTemplateVariantSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int().nonnegative(),
  items: z.array(orderTemplatePrintSchema)
})
export type OrderTemplateVariant = z.infer<typeof orderTemplateVariantSchema>

export const orderTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: optionalCodeSchema,
  description: optionalLongTextSchema,
  notesTemplate: optionalLongTextSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  variants: z.array(orderTemplateVariantSchema),
  items: z.array(orderTemplatePrintSchema)
})
export type OrderTemplate = z.infer<typeof orderTemplateSchema>

export const orderTemplateListSchema = z.object({
  templates: z.array(orderTemplateSchema)
})
export type OrderTemplateList = z.infer<typeof orderTemplateListSchema>

export const orderCreateSchema = z.object({
  templateId: z.string().min(1),
  name: shortTextSchema,
  notes: optionalLongTextSchema.optional(),
  printFilamentOverrides: z.array(z.object({
    templatePrintId: z.string().min(1),
    variantCopyIndex: z.number().int().nonnegative().max(999),
    projectFilaments: z.array(threeMfProjectFilamentSchema).max(64)
  })).max(200).optional(),
  variants: z.array(z.object({
    variantId: z.string().min(1),
    quantity: z.number().int().positive().max(999)
  })).min(1).max(25).optional()
})
export type OrderCreateInput = z.infer<typeof orderCreateSchema>

export const orderUpdateSchema = z.object({
  name: shortTextSchema.optional(),
  notes: optionalLongTextSchema.optional(),
  status: orderStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: 'Provide at least one field to update'
})
export type OrderUpdateInput = z.infer<typeof orderUpdateSchema>

export const startOrderPrintSchema = printFromLibrarySchema.omit({ fileId: true }).extend({
  /**
   * When the order item references an unsliced project 3MF, the client slices
   * it first and passes the sliced output's library file id here. Dispatch
   * uses that file while the order item keeps pointing at the source 3MF.
   */
  slicedFileId: z.string().optional()
})
export type StartOrderPrintInput = z.infer<typeof startOrderPrintSchema>

export const orderProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  awaitingConfirmation: z.number().int().nonnegative()
})
export type OrderProgress = z.infer<typeof orderProgressSchema>

export const orderPrintSchema = z.object({
  id: z.string(),
  templatePrintId: z.string().nullable(),
  templateVariantId: z.string().nullable(),
  templateVariantName: z.string().nullable(),
  projectFilamentOverrides: z.array(threeMfProjectFilamentSchema).nullable(),
  libraryFileId: z.string().nullable(),
  libraryFileName: z.string(),
  plate: z.number().int().positive(),
  notes: optionalItemNotesSchema,
  groupPosition: z.number().int().nonnegative(),
  sequenceNumber: z.number().int().positive(),
  sequenceCount: z.number().int().positive(),
  status: orderPrintStatusSchema,
  activityState: orderPrintActivityStateSchema,
  completionSource: orderPrintCompletionSourceSchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  startedAt: z.string().nullable(),
  startedPrinterId: z.string().nullable(),
  startedPrinterName: z.string().nullable(),
  lastPrintJobId: z.string().nullable(),
  lastPrintResult: z.enum(['success', 'failed', 'cancelled']).nullable(),
  lastPrintFinishedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  fileAvailable: z.boolean()
})
export type OrderPrint = z.infer<typeof orderPrintSchema>

export const orderSelectedVariantSchema = z.object({
  id: z.string(),
  templateVariantId: z.string().nullable(),
  templateVariantName: z.string(),
  quantity: z.number().int().positive(),
  position: z.number().int().nonnegative()
})
export type OrderSelectedVariant = z.infer<typeof orderSelectedVariantSchema>

export const orderSchema = z.object({
  id: z.string(),
  templateId: z.string().nullable(),
  templateName: z.string(),
  templateCode: optionalCodeSchema,
  templateDescription: optionalLongTextSchema,
  name: z.string(),
  notes: optionalLongTextSchema,
  status: orderStatusSchema,
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  selectedVariants: z.array(orderSelectedVariantSchema),
  progress: orderProgressSchema,
  prints: z.array(orderPrintSchema)
})
export type Order = z.infer<typeof orderSchema>

export const orderListSchema = z.object({
  orders: z.array(orderSchema)
})
export type OrderList = z.infer<typeof orderListSchema>