import { z } from 'zod'
import { printerModelSchema } from './printer.js'

export const printerViewStateFilterSchema = z.enum([
  'all',
  'idle',
  'printing',
  'paused',
  'error',
  'offline'
])
export type PrinterViewStateFilter = z.infer<typeof printerViewStateFilterSchema>

/**
 * Optional attribute filters layered on top of the state filter. Each is a set
 * of allowed values; an empty array means "no filter" (include every printer).
 * A printer is included when it matches every active filter.
 */
export const printerViewModelFilterSchema = z.array(printerModelSchema)
export type PrinterViewModelFilter = z.infer<typeof printerViewModelFilterSchema>

export const printerViewNozzleDiameterFilterSchema = z.array(z.string().trim().min(1))
export type PrinterViewNozzleDiameterFilter = z.infer<typeof printerViewNozzleDiameterFilterSchema>

export const printerViewPlateTypeFilterSchema = z.array(z.string().trim().min(1))
export type PrinterViewPlateTypeFilter = z.infer<typeof printerViewPlateTypeFilterSchema>

export const printerViewSortKeySchema = z.enum([
  'manual',
  'name',
  'model',
  'state'
])
export type PrinterViewSortKey = z.infer<typeof printerViewSortKeySchema>

export const printerViewSortDirectionSchema = z.enum(['asc', 'desc'])
export type PrinterViewSortDirection = z.infer<typeof printerViewSortDirectionSchema>

export const printerViewSortSchema = z.object({
  key: printerViewSortKeySchema,
  direction: printerViewSortDirectionSchema
})
export type PrinterViewSort = z.infer<typeof printerViewSortSchema>

export const printerCardContentSettingsSchema = z.object({
  nozzleTemperatures: z.boolean(),
  bedTemperature: z.boolean(),
  chamberTemperature: z.boolean(),
  printSpeed: z.boolean(),
  printStatus: z.boolean().default(true),
  doorState: z.boolean().default(false),
  ductState: z.boolean().default(false),
  modelThumbnail: z.boolean(),
  cameraThumbnail: z.boolean(),
  fullWidthSnapshot: z.boolean().default(false),
  amsCards: z.boolean(),
  footerControls: z.boolean()
})
export type PrinterCardContentSettings = z.infer<typeof printerCardContentSettingsSchema>

export const defaultPrinterCardContentSettings: PrinterCardContentSettings = {
  nozzleTemperatures: true,
  bedTemperature: true,
  chamberTemperature: true,
  printSpeed: true,
  printStatus: true,
  doorState: false,
  ductState: false,
  modelThumbnail: true,
  cameraThumbnail: true,
  fullWidthSnapshot: false,
  amsCards: true,
  footerControls: true
}

export const defaultPrinterViewSort: PrinterViewSort = {
  key: 'name',
  direction: 'asc'
}

export const printerViewInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  printerIds: z.array(z.string()).default([]),
  cardsPerRow: z.number().int().min(1).max(6).default(3),
  stateFilter: printerViewStateFilterSchema.default('all'),
  modelFilter: printerViewModelFilterSchema.default([]),
  nozzleDiameterFilter: printerViewNozzleDiameterFilterSchema.default([]),
  plateTypeFilter: printerViewPlateTypeFilterSchema.default([]),
  sort: printerViewSortSchema.default(defaultPrinterViewSort),
  cardContentSettings: printerCardContentSettingsSchema.default(defaultPrinterCardContentSettings)
})
export type PrinterViewInput = z.infer<typeof printerViewInputSchema>

export const printerViewSchema = printerViewInputSchema.extend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type PrinterView = z.infer<typeof printerViewSchema>

export const printerViewListSchema = z.object({
  views: z.array(printerViewSchema)
})
export type PrinterViewList = z.infer<typeof printerViewListSchema>
