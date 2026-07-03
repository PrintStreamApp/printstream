/**
 * Shared helper for notification plugins.
 *
 * Notification plugins differ only in how they deliver a message
 * (HTTP webhook to ntfy, HTTP webhook to Discord, WebSocket fan-out
 * to browser clients). The mapping from a printer-domain event to a
 * `NotificationMessage` is identical, so it lives here.
 *
 * Every notification plugin should call {@link subscribePrinterNotifications}
 * during `register` and dispose the returned cleanup in `onShutdown`.
 * Adding new notification triggers (job started, error, etc) only
 * needs a new branch here; every channel picks them up automatically.
 *
 * ## Tenant scoping
 *
 * Each formatted `NotificationMessage` includes a `tenantId` resolved
 * from the printer manager's cached mapping. Delivery plugins use this
 * to look up the correct per-tenant configuration (webhook URL, push
 * subscriptions, etc.) and to filter events so Tenant A's channel
 * never receives Tenant B's notifications.
 */
import { randomUUID } from 'node:crypto'
import {
  isPrinterActiveJobStage,
  type NotificationMessage,
  type NotificationTemplateEvent,
  type Printer,
  type PrinterStatus
} from '@printstream/shared'
import type { PrinterEventBus } from './printer-events.js'
import { fetchSnapshot, supportsChamberCamera } from './camera.js'
import { env } from './env.js'
import { renderNotificationTemplate } from './notification-templates.js'
import { storeSnapshot } from './notification-snapshots.js'
import { rootPrisma } from './prisma.js'
import { printerManager } from './printer-manager.js'

export type NotificationHandler = (message: NotificationMessage) => void | Promise<void>

interface JobFinishedEvent {
  jobId: string
  printer: Printer
  jobName: string
  result: 'success' | 'failed' | 'cancelled'
  snapshotPath: string | null
}

interface JobStartedEvent {
  jobId: string
  printer: Printer
  jobName: string
}

interface JobPausedEvent {
  printer: Printer
  jobName: string
  reason: string | null
}

interface JobErrorEvent {
  printer: Printer
  jobName: string
  errorCode: string
  errorMessage: string
}

interface PrinterNotificationState {
  stage: PrinterStatus['stage']
  /**
   * Error codes (device + HMS) already notified for the current job episode.
   * Sticky across status updates — including transient empty HMS lists that
   * MQTT reconnects emit before the first full report — so the same set of
   * errors is never re-notified. Reset when a job (re)enters an active stage.
   */
  notifiedErrorCodes: Set<string>
}

interface StatusErrorEntry {
  code: string
  message: string
}

const RESULT_LEVEL: Record<JobFinishedEvent['result'], NotificationMessage['level']> = {
  success: 'success',
  failed: 'error',
  cancelled: 'warning'
}

const RESULT_LABEL: Record<JobFinishedEvent['result'], string> = {
  success: 'finished',
  failed: 'failed',
  cancelled: 'cancelled'
}

const FINISHED_TEMPLATE: Record<JobFinishedEvent['result'], NotificationTemplateEvent> = {
  success: 'job.finished.success',
  failed: 'job.finished.failed',
  cancelled: 'job.finished.cancelled'
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Best-effort snapshot capture. Returns `null` (and logs nothing) when
 * the printer doesn't support a chamber camera, or when the camera
 * call throws. We don't want a transient camera failure to block the
 * notification from going out.
 *
 * `preferPrecaptured` is only used for transient notification-owned
 * started-event images. Finished-event images should come from the
 * persisted `PrintJob` snapshot path instead.
 */
async function captureSnapshotUrl(
  printer: Printer,
  _options: { preferPrecaptured?: boolean } = {}
): Promise<string | null> {
  if (!supportsChamberCamera(printer.model)) return null
  try {
    const buffer = await fetchSnapshot(printer)
    const id = storeSnapshot(buffer, 'image/jpeg')
    const path = `/api/notifications/snapshots/${id}`
    return env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}${path}` : path
  } catch {
    return null
  }
}

async function captureJobSnapshotUrl(jobId: string): Promise<string | null> {
  const path = `/api/jobs/${jobId}/snapshot`
  return env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}${path}` : path
}

async function formatJobFinished(event: JobFinishedEvent): Promise<NotificationMessage | null> {
  const rendered = renderNotificationTemplate(FINISHED_TEMPLATE[event.result], {
    printerName: event.printer.name,
    jobName: event.jobName,
    result: RESULT_LABEL[event.result]
  })
  if (!rendered.enabled) return null
  const imageUrl = rendered.includeSnapshot
    ? (event.snapshotPath ? await captureJobSnapshotUrl(event.jobId) : null)
    : null
  const url = await resolvePrinterNotificationUrl(event.printer.id)
  return {
    id: randomUUID(),
    category: 'job.finished',
    level: RESULT_LEVEL[event.result],
    title: rendered.title,
    body: rendered.body,
    timestamp: nowIso(),
    printerId: event.printer.id,
    printerName: event.printer.name,
    tenantId: printerManager.getTenantId(event.printer.id),
    // One per printer: lets browser/Discord-style clients replace the
    // previous "started" notification with the "finished" one.
    tag: `printer:${event.printer.id}:job`,
    url,
    imageUrl: imageUrl ?? undefined
  }
}

async function formatJobStarted(event: JobStartedEvent): Promise<NotificationMessage | null> {
  const rendered = renderNotificationTemplate('job.started', {
    printerName: event.printer.name,
    jobName: event.jobName
  })
  if (!rendered.enabled) return null
  const imageUrl = rendered.includeSnapshot ? await captureSnapshotUrl(event.printer) : null
  const url = await resolvePrinterNotificationUrl(event.printer.id)
  return {
    id: randomUUID(),
    category: 'job.started',
    level: 'info',
    title: rendered.title,
    body: rendered.body,
    timestamp: nowIso(),
    printerId: event.printer.id,
    printerName: event.printer.name,
    tenantId: printerManager.getTenantId(event.printer.id),
    tag: `printer:${event.printer.id}:job`,
    url,
    imageUrl: imageUrl ?? undefined
  }
}

async function formatJobPaused(event: JobPausedEvent): Promise<NotificationMessage | null> {
  const rendered = renderNotificationTemplate('job.paused', {
    printerName: event.printer.name,
    jobName: event.jobName,
    reason: event.reason ?? ''
  })
  if (!rendered.enabled) return null
  const imageUrl = rendered.includeSnapshot ? await captureSnapshotUrl(event.printer) : null
  const url = await resolvePrinterNotificationUrl(event.printer.id)
  return {
    id: randomUUID(),
    category: 'job.paused',
    level: 'warning',
    title: rendered.title,
    body: rendered.body,
    timestamp: nowIso(),
    printerId: event.printer.id,
    printerName: event.printer.name,
    tenantId: printerManager.getTenantId(event.printer.id),
    tag: `printer:${event.printer.id}:job`,
    url,
    imageUrl: imageUrl ?? undefined
  }
}

async function formatJobError(event: JobErrorEvent): Promise<NotificationMessage | null> {
  const rendered = renderNotificationTemplate('job.error', {
    printerName: event.printer.name,
    jobName: event.jobName,
    errorMessage: event.errorMessage,
    errorCode: event.errorCode
  })
  if (!rendered.enabled) return null
  const imageUrl = rendered.includeSnapshot ? await captureSnapshotUrl(event.printer) : null
  const url = await resolvePrinterNotificationUrl(event.printer.id)
  return {
    id: randomUUID(),
    category: 'job.error',
    level: 'error',
    title: rendered.title,
    body: rendered.body,
    timestamp: nowIso(),
    printerId: event.printer.id,
    printerName: event.printer.name,
    tenantId: printerManager.getTenantId(event.printer.id),
    tag: `printer:${event.printer.id}:job`,
    url,
    imageUrl: imageUrl ?? undefined
  }
}

async function formatBridgeCrashed(event: {
  bridgeId: string
  bridgeName: string
  tenantId: string | null
  recentCrashCount: number
}): Promise<NotificationMessage | null> {
  const rendered = renderNotificationTemplate('bridge.crashed', {
    bridgeName: event.bridgeName,
    crashCount: String(event.recentCrashCount)
  })
  if (!rendered.enabled) return null
  return {
    id: randomUUID(),
    category: 'bridge.crashed',
    level: 'error',
    title: rendered.title,
    body: rendered.body,
    timestamp: nowIso(),
    tenantId: event.tenantId ?? undefined,
    // Collapse repeated crash notices for the same bridge on channels that honor tags.
    tag: `bridge:${event.bridgeId}:crash`,
    url: await resolveBridgeNotificationUrl(event.tenantId)
  }
}

async function resolveBridgeNotificationUrl(tenantId: string | null): Promise<string> {
  if (!tenantId) return '/workspaces'
  const tenant = await rootPrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true }
  })
  return tenant?.slug ? `/workspaces/${tenant.slug}/settings/bridges` : '/workspaces'
}

async function resolvePrinterNotificationUrl(printerId: string): Promise<string> {
  const tenantId = printerManager.getTenantId(printerId)
  if (!tenantId) {
    return '/workspaces'
  }

  const tenant = await rootPrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true }
  })

  return tenant?.slug ? `/workspaces/${tenant.slug}/printers/${printerId}` : '/workspaces'
}

/**
 * Subscribe a delivery handler to all printer events that should
 * surface as user notifications. Returns a disposer.
 *
 * The handler is awaited so plugins can implement back-pressure if
 * needed; thrown errors are swallowed so one channel cannot break
 * another.
 */
export function subscribePrinterNotifications(
  bus: PrinterEventBus,
  handler: NotificationHandler,
  options: {
    onError?: (error: unknown) => void
    shouldHandleTenantId?: (tenantId: string | null) => boolean
  } = {}
): () => void {
  const printerStates = new Map<string, PrinterNotificationState>()

  const safeHandler = async (message: NotificationMessage) => {
    try {
      await handler(message)
    } catch (error) {
      options.onError?.(error)
    }
  }

  const onJobFinished = (event: JobFinishedEvent) => {
    void (async () => {
      try {
        const tenantId = printerManager.getTenantId(event.printer.id) ?? null
        if (options.shouldHandleTenantId && !options.shouldHandleTenantId(tenantId)) return
        const message = await formatJobFinished(event)
        if (message) await safeHandler(message)
      } catch (error) {
        options.onError?.(error)
      }
    })()
  }
  const onJobStarted = (event: JobStartedEvent) => {
    void (async () => {
      try {
        const tenantId = printerManager.getTenantId(event.printer.id) ?? null
        if (options.shouldHandleTenantId && !options.shouldHandleTenantId(tenantId)) return
        const message = await formatJobStarted(event)
        if (message) await safeHandler(message)
      } catch (error) {
        options.onError?.(error)
      }
    })()
  }

  const onStatus = (status: PrinterStatus) => {
    const currentErrors = readStatusErrors(status)
    const previousState = printerStates.get(status.printerId)
    // A fresh active stage (new job, or a retried one) starts a new error
    // episode: re-baseline the set to the errors present right now, so chronic
    // standing errors stay quiet while a cleared-then-recurring one notifies
    // again. Mid-episode the set carries forward unchanged, so transient clears
    // (e.g. the empty HMS list an MQTT reconnect emits) cannot re-notify.
    const startsNewJobEpisode = previousState != null
      && !isPrinterActiveJobStage(previousState.stage)
      && isPrinterActiveJobStage(status.stage)
    const notifiedErrorCodes = previousState != null && !startsNewJobEpisode
      ? previousState.notifiedErrorCodes
      : new Set(currentErrors.map((entry) => entry.code))
    printerStates.set(status.printerId, { stage: status.stage, notifiedErrorCodes })
    if (!previousState || !status.online) {
      return
    }

    const newErrors = isPrinterActiveJobStage(status.stage)
      ? currentErrors.filter((entry) => !notifiedErrorCodes.has(entry.code))
      : []
    // Mark before the async work below so overlapping status events for the
    // same printer cannot send the same error twice.
    for (const entry of newErrors) notifiedErrorCodes.add(entry.code)

    void (async () => {
      try {
        const tenantId = printerManager.getTenantId(status.printerId) ?? null
        if (options.shouldHandleTenantId && !options.shouldHandleTenantId(tenantId)) return
        const printer = printerManager.getPrinter(status.printerId)
        if (!printer) return
        const jobName = readNotificationJobName(status)

        if (previousState.stage !== 'paused' && status.stage === 'paused') {
          const paused = await formatJobPaused({
            printer,
            jobName,
            reason: readPauseReason(status)
          })
          if (paused) await safeHandler(paused)
        }

        if (newErrors.length > 0) {
          const errored = await formatJobError({
            printer,
            jobName,
            errorCode: newErrors.map((entry) => entry.code).join(', '),
            errorMessage: newErrors.map((entry) => entry.message).join('\n')
          })
          if (errored) await safeHandler(errored)
        }
      } catch (error) {
        options.onError?.(error)
      }
    })()
  }

  const onBridgeCrashed = (event: {
    bridgeId: string
    bridgeName: string
    tenantId: string | null
    recentCrashCount: number
  }) => {
    void (async () => {
      try {
        if (options.shouldHandleTenantId && !options.shouldHandleTenantId(event.tenantId)) return
        const message = await formatBridgeCrashed(event)
        if (message) await safeHandler(message)
      } catch (error) {
        options.onError?.(error)
      }
    })()
  }

  bus.on('print-job.finished', onJobFinished)
  bus.on('print-job.started', onJobStarted)
  bus.on('status', onStatus)
  bus.on('bridge.crashed', onBridgeCrashed)

  return () => {
    bus.off('print-job.finished', onJobFinished)
    bus.off('print-job.started', onJobStarted)
    bus.off('status', onStatus)
    bus.off('bridge.crashed', onBridgeCrashed)
  }
}

function readNotificationJobName(status: PrinterStatus): string {
  return status.jobName ?? printerManager.getLastJobName(status.printerId) ?? ''
}

function readPauseReason(status: PrinterStatus): string | null {
  return status.deviceError?.message
    ?? status.hmsErrors[0]?.message
    ?? status.subStage
}

/** Flatten the device error and every HMS error into one list of code+message entries. */
function readStatusErrors(status: PrinterStatus): StatusErrorEntry[] {
  const entries: StatusErrorEntry[] = []
  if (status.deviceError) {
    entries.push({
      code: status.deviceError.code,
      message: status.deviceError.message ?? `Printer reported error ${status.deviceError.code}`
    })
  }
  for (const hmsError of status.hmsErrors) {
    entries.push({ code: hmsError.code, message: hmsError.message ?? hmsError.code })
  }
  return entries
}
