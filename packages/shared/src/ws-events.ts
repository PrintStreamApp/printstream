/**
 * WebSocket event contracts. The web client opens one WS connection to
 * `/ws` and receives a tagged stream of events. New event types should be
 * added to the discriminated union so both ends stay aligned.
 */
import { z } from 'zod'
import { bridgeDebugCaptureStatusSchema } from './bridges.js'
import { discoveredPrinterSchema, printerStatusSchema, printerSchema } from './printer.js'

export const wsHelloEventSchema = z.object({
  type: z.literal('hello'),
  serverTime: z.string()
})
export type WsHelloEvent = z.infer<typeof wsHelloEventSchema>

export const wsPrinterStatusEventSchema = z.object({
  type: z.literal('printer.status'),
  status: printerStatusSchema
})
export type WsPrinterStatusEvent = z.infer<typeof wsPrinterStatusEventSchema>

export const wsPrinterListEventSchema = z.object({
  type: z.literal('printer.list'),
  printers: z.array(printerSchema)
})
export type WsPrinterListEvent = z.infer<typeof wsPrinterListEventSchema>

export const wsPrinterRemovedEventSchema = z.object({
  type: z.literal('printer.removed'),
  printerId: z.string()
})
export type WsPrinterRemovedEvent = z.infer<typeof wsPrinterRemovedEventSchema>

export const wsPrinterDiscoveredEventSchema = z.object({
  type: z.literal('printer.discovered'),
  printers: z.array(discoveredPrinterSchema)
})
export type WsPrinterDiscoveredEvent = z.infer<typeof wsPrinterDiscoveredEventSchema>

export const wsCameraSnapshotUpdatedEventSchema = z.object({
  type: z.literal('camera.snapshot.updated'),
  printerId: z.string(),
  capturedAt: z.number().int().nonnegative()
})
export type WsCameraSnapshotUpdatedEvent = z.infer<typeof wsCameraSnapshotUpdatedEventSchema>

export const wsPrinterFtpActivityEventSchema = z.object({
  type: z.literal('printer.ftps.active'),
  printerId: z.string(),
  active: z.boolean()
})
export type WsPrinterFtpActivityEvent = z.infer<typeof wsPrinterFtpActivityEventSchema>

/**
 * Coarse invalidation event for views backed by normal HTTP queries.
 * The payload names the mutated resource so other clients can refresh
 * the matching React Query caches without inventing a second sync path.
 */
export const wsResourceChangedEventSchema = z.object({
  type: z.literal('resource.changed'),
  resource: z.enum([
    'bridges',
    'delete-operations',
    'jobs',
    'library',
    'logs',
    'orders',
    'printer.views',
    'printer.storage',
    'notification.templates',
    'plugins',
    'plugin.settings',
    'print-dispatch',
    'slicing',
    // The slicer PROFILE catalogue (machines/processes/filaments). Emitted only when profiles
    // actually change (custom profile create/delete), NOT on slice progress — so the slow profiles
    // query is not refetched sub-second for the duration of a slice. Distinct from 'slicing', which
    // fires on every job state/progress change and invalidates only the jobs list.
    'slicing.profiles'
  ]),
  printerId: z.string().optional(),
  pluginName: z.string().optional()
})
export type WsResourceChangedEvent = z.infer<typeof wsResourceChangedEventSchema>

export const wsAuthChangedEventSchema = z.object({
  type: z.literal('auth.changed')
})
export type WsAuthChangedEvent = z.infer<typeof wsAuthChangedEventSchema>

/**
 * Live debug-capture state for a bridge. Emitted when a capture starts, stops,
 * or auto-stops so the global "capture active" banner and the settings controls
 * update in real time without polling.
 */
export const wsBridgeDebugCaptureEventSchema = z.object({
  type: z.literal('bridge.debug.capture'),
  bridgeId: z.string(),
  status: bridgeDebugCaptureStatusSchema
})
export type WsBridgeDebugCaptureEvent = z.infer<typeof wsBridgeDebugCaptureEventSchema>

export const wsErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string()
})
export type WsErrorEvent = z.infer<typeof wsErrorEventSchema>

/**
 * Generic plugin event envelope. Plugins broadcast their own messages
 * over the shared WebSocket without forcing a schema change for every
 * plugin. The `pluginName` field lets the matching web plugin filter
 * out events from other plugins; `event` is a free-form payload owned
 * by the plugin itself.
 */
export const wsPluginEventSchema = z.object({
  type: z.literal('plugin.event'),
  pluginName: z.string(),
  event: z.unknown()
})
export type WsPluginEvent = z.infer<typeof wsPluginEventSchema>

export const wsEventSchema = z.discriminatedUnion('type', [
  wsHelloEventSchema,
  wsPrinterStatusEventSchema,
  wsPrinterListEventSchema,
  wsPrinterRemovedEventSchema,
  wsPrinterDiscoveredEventSchema,
  wsCameraSnapshotUpdatedEventSchema,
  wsPrinterFtpActivityEventSchema,
  wsResourceChangedEventSchema,
  wsAuthChangedEventSchema,
  wsBridgeDebugCaptureEventSchema,
  wsPluginEventSchema,
  wsErrorEventSchema
])
export type WsEvent = z.infer<typeof wsEventSchema>
