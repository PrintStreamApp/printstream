/**
 * Firmware-updates plugin (built-in, API side).
 *
 * Adds two related capabilities on top of the core printer manager:
 *
 * 1. Tells the user which Bambu Lab firmware version is currently
 *    installed on each printer and whether a newer version has been
 *    announced on bambulab.com / the Bambu wiki.
 * 2. For LAN-only updates, downloads the requested firmware file and
 *    uploads it to the printer's SD card root via the existing FTPS
 *    helper. The actual flash still happens from the printer screen
 *    (Settings > Firmware) — Bambu does not expose a remote trigger.
 *
 * Upload progress is broadcast to web clients via the shared
 * `plugin.event` envelope so the firmware page can show a live
 * progress bar without polling.
 */
import { z } from 'zod'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import {
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  throwIfAborted
} from '@printstream/shared'
import type { ApiPlugin } from '../../plugin/types.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { env } from '../../lib/env.js'
import { printerManager } from '../../lib/printer-manager.js'
import { assertTenantOwnsPrinter, requireTenantOwnedConnectedPrinter } from '../../lib/printer-access.js'
import { listPrinterDirectory, uploadFileToPrinter } from '../../lib/printer-ftp.js'
import { badRequest, conflict, notFound } from '../../lib/http-error.js'
import { assertSafeOutboundUrl } from '../../lib/outbound-url-guard.js'
import { requireRouteParam } from '../../lib/request-helpers.js'
import { FirmwareSource, compareVersions, type FirmwareVersion } from './firmware-source.js'

/**
 * Firmware binaries are downloaded server-side and staged on the printer SD card,
 * so the source URL (scraped from Bambu's download page) is pinned to Bambu's own
 * hosts/CDN over https — never an arbitrary, attacker-influenced URL.
 */
const FIRMWARE_ALLOWED_HOSTS = ['bblmw.com', 'bambulab.com'] as const

type UploadStatus = 'idle' | 'preparing' | 'downloading' | 'uploading' | 'complete' | 'cancelled' | 'error'
const DEFAULT_FIRMWARE_VERSION_REFRESH_TIMEOUT_MS = 1_500
let firmwareVersionRefreshTimeoutMs = DEFAULT_FIRMWARE_VERSION_REFRESH_TIMEOUT_MS

export function setFirmwareVersionRefreshTimeoutMsForTests(timeoutMs: number | null): void {
  firmwareVersionRefreshTimeoutMs = timeoutMs ?? DEFAULT_FIRMWARE_VERSION_REFRESH_TIMEOUT_MS
}

interface UploadState {
  status: UploadStatus
  progress: number
  message: string
  error: string | null
  firmwareFilename: string | null
  firmwareVersion: string | null
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isActiveUploadState(state: UploadState): boolean {
  return state.status === 'preparing' || state.status === 'downloading' || state.status === 'uploading'
}

function makeIdleState(): UploadState {
  return {
    status: 'idle',
    progress: 0,
    message: '',
    error: null,
    firmwareFilename: null,
    firmwareVersion: null
  }
}

const startUploadSchema = z
  .object({
    /** Specific version to install. Defaults to the latest published version. */
    version: z.string().trim().min(1).max(64).optional()
  })
  .strict()

export const firmwareUpdatesPlugin: ApiPlugin = {
  name: 'firmware-updates',
  version: '0.1.0',
  description: 'Check for Bambu Lab firmware updates and upload firmware to a printer\'s SD card.',
  async register(context) {
    const source = new FirmwareSource(context.logger)
    const cacheDir = path.resolve(env.PLUGINS_DIR, 'firmware-updates', 'cache')
    await mkdir(cacheDir, { recursive: true })

    /** Per-printer upload state. */
    const states = new Map<string, UploadState>()
    const uploadControllers = new Map<string, AbortController>()
    const stateFor = (printerId: string): UploadState => {
      let s = states.get(printerId)
      if (!s) {
        s = makeIdleState()
        states.set(printerId, s)
      }
      return s
    }
    const resetState = (printerId: string): UploadState => {
      const next = makeIdleState()
      states.set(printerId, next)
      return next
    }

    const broadcast = (printerId: string, state: UploadState): void => {
      // A null tenantId fans out to every connected client across all tenants, so skip
      // the broadcast rather than leak when the printer's tenant can't be resolved.
      const tenantId = printerManager.getTenantId(printerId)
      if (!tenantId) return
      context.ws.broadcast({
        type: 'plugin.event',
        pluginName: 'firmware-updates',
        event: {
          kind: 'upload-progress',
          printerId,
          status: state.status,
          progress: state.progress,
          message: state.message,
          error: state.error,
          firmwareFilename: state.firmwareFilename,
          firmwareVersion: state.firmwareVersion
        }
      }, tenantId)
    }

    const refreshFirmwareStatus = async (
      printerId: string
    ): Promise<ReturnType<typeof printerManager.getStatus>> => {
      const status = printerManager.getStatus(printerId)
      if (!status?.online || status.firmwareVersion) return status

      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined

      return await new Promise<ReturnType<typeof printerManager.getStatus>>((resolve) => {
        const finish = (timedOut: boolean): void => {
          if (done) return
          done = true
          if (timer) clearTimeout(timer)
          context.printerEvents.off('status', onStatus)
          if (timedOut) {
            context.logger.warn(`firmware version refresh timed out for printer ${printerId}`)
          }
          resolve(printerManager.getStatus(printerId))
        }

        const onStatus = (nextStatus: { printerId: string; online: boolean; firmwareVersion: string | null }) => {
          if (nextStatus.printerId !== printerId) return
          if (!nextStatus.online || nextStatus.firmwareVersion) finish(false)
        }

        context.printerEvents.on('status', onStatus)

        if (!printerManager.publishCommand(printerId, { info: { command: 'get_version' } })) {
          context.printerEvents.off('status', onStatus)
          context.logger.warn(`firmware version refresh request failed for printer ${printerId}`)
          resolve(printerManager.getStatus(printerId))
          return
        }

        timer = setTimeout(() => finish(true), firmwareVersionRefreshTimeoutMs)
      })
    }

    /**
     * `complete` is only trustworthy if the firmware is still present on
     * the printer SD card and the printer has not already installed it.
     * Manual SD cleanup or a successful flash would otherwise leave the
     * in-memory state stuck at "ready to flash" forever.
     */
    const reconcileUploadState = async (printerId: string): Promise<UploadState> => {
      const state = stateFor(printerId)
      if (state.status !== 'complete') return state

      const printer = printerManager.getPrinter(printerId)
      if (!printer) return state
      let status = printerManager.getStatus(printerId)
      if (status?.online && !status.firmwareVersion) {
        status = await refreshFirmwareStatus(printerId)
      }

      if (
        state.firmwareVersion
        && status?.firmwareVersion
        && compareVersions(status.firmwareVersion, state.firmwareVersion) >= 0
      ) {
        const next = resetState(printerId)
        broadcast(printerId, next)
        return next
      }

      if (!state.firmwareFilename || status?.sdCardPresent === false) {
        const next = resetState(printerId)
        broadcast(printerId, next)
        return next
      }

      try {
        const entries = await listPrinterDirectory(printer, '/')
        const firmwareStillPresent = entries.some(
          (entry) => entry.type === 'file' && entry.name === state.firmwareFilename
        )
        if (!firmwareStillPresent) {
          const next = resetState(printerId)
          broadcast(printerId, next)
          return next
        }
      } catch (error) {
        // Keep the current state when we cannot verify the SD card. Log it so
        // an unreachable printer is distinguishable from a deleted file.
        context.logger.warn(`Could not verify firmware file on ${printerId} SD card`, error)
      }

      return state
    }

    /**
     * Build the user-facing update report for one printer. Shape mirrors
     * what the web plugin renders so we don't have to map twice.
     */
    const buildReport = async (printerId: string): Promise<UpdateReport | null> => {
      const printer = printerManager.getPrinter(printerId)
      if (!printer) return null
      let status = printerManager.getStatus(printerId)
      if (status?.online && !status.firmwareVersion) {
        status = await refreshFirmwareStatus(printerId)
      }
      const currentVersion = status?.firmwareVersion ?? null
      const versions = await source.listVersions(printer.model)
      const latest = versions[0] ?? null
      const updateAvailable = Boolean(
        latest && currentVersion && compareVersions(latest.version, currentVersion) > 0
      )
      return {
        printerId,
        printerName: printer.name,
        model: printer.model,
        online: status?.online ?? false,
        currentVersion,
        sdCardPresent: status?.sdCardPresent ?? null,
        latestVersion: latest?.version ?? null,
        updateAvailable,
        downloadUrl: latest?.downloadUrl || null,
        releaseNotes: latest?.releaseNotes ?? null,
        // Per-module versions (each AMS unit, controllers) minus `ota`, which is
        // already reported as `currentVersion`. Bambu publishes no separate
        // "latest" for these, so they are display-only — they let the user see
        // whether an AMS unit lags the main firmware.
        modules: (status?.firmwareModules ?? [])
          .filter((module) => module.name !== 'ota')
          .map((module) => ({
            name: module.name,
            version: module.version,
            hardwareVersion: module.hardwareVersion,
            isAms: isAmsModuleName(module.name)
          })),
        availableVersions: versions.map((v) => ({
          version: v.version,
          fileAvailable: Boolean(v.downloadUrl),
          releaseNotes: v.releaseNotes,
          releaseTime: v.releaseTime
        }))
      }
    }

    /**
     * Resolve the firmware version to install for an upload request.
     * Defaults to the latest published version with a download URL.
     * Throws when nothing installable is available.
     */
    const resolveTarget = async (
      printer: { model: string },
      requestedVersion: string | undefined,
      signal?: AbortSignal
    ): Promise<FirmwareVersion> => {
      if (requestedVersion) {
        const found = await source.findVersion(printer.model, requestedVersion, signal)
        if (!found) throw badRequest(`Firmware version ${requestedVersion} is not published for this model`)
        if (!found.downloadUrl) throw badRequest(`Firmware ${requestedVersion} is announced but no download is available yet`)
        return found
      }
      const versions = await source.listVersions(printer.model, signal)
      const installable = versions.find((v) => Boolean(v.downloadUrl))
      if (!installable) throw badRequest('No installable firmware is available for this printer model')
      return installable
    }

    /**
     * Stream the firmware blob from bambulab.com into the cache dir,
     * keyed by the file's basename so subsequent installs of the same
     * version skip the download. Returns the cached file path.
     */
    const downloadFirmware = async (
      printerId: string,
      target: FirmwareVersion,
      state: UploadState,
      signal?: AbortSignal
    ): Promise<string> => {
      throwIfAborted(signal)
      // Pin the download to Bambu's CDN over https before fetching the bytes.
      const downloadUrl = assertSafeOutboundUrl(target.downloadUrl, { allowedHosts: FIRMWARE_ALLOWED_HOSTS })
      const filename = path.basename(downloadUrl.pathname) || `firmware_${target.version}.bin`
      const cachePath = path.join(cacheDir, filename)
      try {
        await stat(cachePath)
        throwIfAborted(signal)
        state.firmwareFilename = filename
        return cachePath
      } catch {
        // not cached, fall through to download
      }
      const tempPath = path.join(cacheDir, `.downloading_${filename}`)
      try {
        await unlink(tempPath)
      } catch {
        // best-effort
      }
      try {
        const response = await fetch(downloadUrl, { signal })
        if (!response.ok || !response.body) {
          throw new Error(`Firmware download failed (${response.status})`)
        }
        const total = Number(response.headers.get('content-length') ?? 0)
        let received = 0
        let lastBroadcast = 0
        const bodyStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
        bodyStream.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (total > 0) {
            const pct = Math.min(99, Math.round((received / total) * 100))
            if (pct > lastBroadcast) {
              lastBroadcast = pct
              state.progress = pct
              state.message = `Downloading firmware (${pct}%)`
              broadcast(printerId, state)
            }
          }
        })
        await pipeline(bodyStream, createWriteStream(tempPath), { signal })
        await stat(tempPath) // ensure written
        const { rename } = await import('node:fs/promises')
        await rename(tempPath, cachePath)
        state.firmwareFilename = filename
        return cachePath
      } catch (error) {
        await unlink(tempPath).catch(() => undefined)
        throw error
      }
    }

    /** Background driver for an upload. Updates `state` and broadcasts. */
    const runUpload = async (
      printerId: string,
      requestedVersion: string | undefined,
      controller: AbortController
    ): Promise<void> => {
      const state = stateFor(printerId)
      try {
        const printer = printerManager.getPrinter(printerId)
        if (!printer) throw new Error('Printer not connected')
        throwIfAborted(controller.signal)

        state.status = 'preparing'
        state.progress = 0
        state.error = null
        state.message = 'Resolving firmware version…'
        broadcast(printerId, state)

        const target = await resolveTarget(printer, requestedVersion, controller.signal)
        state.firmwareVersion = target.version
        throwIfAborted(controller.signal)

        state.status = 'downloading'
        state.message = 'Downloading firmware from Bambu Lab…'
        broadcast(printerId, state)
        const localPath = await downloadFirmware(printerId, target, state, controller.signal)
        throwIfAborted(controller.signal)

        state.status = 'uploading'
        state.progress = 0
        state.message = `Uploading ${state.firmwareFilename ?? 'firmware'} to printer SD card…`
        broadcast(printerId, state)

        const totalBytes = (await stat(localPath)).size
        let lastUploadPct = -1
        await uploadFileToPrinter(
          printer,
          localPath,
          path.basename(localPath),
          (bytesSent) => {
            if (totalBytes <= 0) return
            const pct = Math.min(99, Math.round((bytesSent / totalBytes) * 100))
            if (pct <= lastUploadPct) return
            lastUploadPct = pct
            state.progress = pct
            state.message = `Uploading ${state.firmwareFilename ?? 'firmware'} to printer SD card (${pct}%)`
            broadcast(printerId, state)
          },
          { signal: controller.signal }
        )

        state.status = 'complete'
        state.progress = 100
        state.message =
          `Firmware ${target.version} uploaded. Open Settings > Firmware on the printer screen to flash it.`
        broadcast(printerId, state)
      } catch (error) {
        if (isAbortError(error)) {
          state.status = 'cancelled'
          state.error = null
          state.message = 'Firmware upload cancelled'
          broadcast(printerId, state)
          return
        }
        const message = error instanceof Error ? error.message : 'Unknown error'
        context.logger.warn(`firmware upload failed for printer ${printerId}`, error)
        state.status = 'error'
        state.error = message
        state.message = `Firmware upload failed: ${message}`
        broadcast(printerId, state)
      } finally {
        if (uploadControllers.get(printerId) === controller) {
          uploadControllers.delete(printerId)
        }
      }
    }

    // --- HTTP routes --------------------------------------------------

    context.router.get('/updates', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (_request, response) => {
      const printers = await context.prisma.printer.findMany({ orderBy: { position: 'asc' }, select: { id: true } })
      const reports: UpdateReport[] = []
      for (const row of printers) {
        const report = await buildReport(row.id)
        if (report) reports.push(report)
      }
      response.json({
        updates: reports,
        updatesAvailable: reports.filter((r) => r.updateAvailable).length
      })
    })

    context.router.get('/updates/:printerId', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
      const printerId = requireRouteParam(request.params.printerId, 'printerId')
      await assertTenantOwnsPrinter(printerId)
      const report = await buildReport(printerId)
      if (!report) throw notFound('Printer not found')
      response.json(report)
    })

    context.router.post('/updates/:printerId/upload', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
      const printerId = requireRouteParam(request.params.printerId, 'printerId')
      // Firmware upload is a safety-relevant SD write — gate on tenant ownership, not
      // just the bare printer id from the manager.
      const printer = await requireTenantOwnedConnectedPrinter(printerId)

      const status = printerManager.getStatus(printerId)
      if (status?.sdCardPresent === false) {
        throw badRequest('No SD card detected in the printer')
      }

      const parsed = startUploadSchema.safeParse(request.body ?? {})
      if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid request body')

      const state = stateFor(printerId)
      if (isActiveUploadState(state)) {
        throw conflict('Firmware upload already in progress for this printer')
      }

      // Reset and kick off background work
      resetState(printerId)
      const controller = new AbortController()
      uploadControllers.set(printerId, controller)
      void runUpload(printerId, parsed.data.version, controller)

      // Firmware pushes are safety-relevant, so audit the request. The exact
      // version may resolve to "latest" in the background; record what was asked.
      annotateRequestAuditLog(request, {
        action: 'start-firmware-upload',
        resource: 'printer firmware',
        summary: `Started a firmware upload to ${printer.name}${parsed.data.version ? ` (version ${parsed.data.version})` : ' (latest version)'}.`,
        metadata: {
          printerId,
          printerName: printer.name,
          version: parsed.data.version ?? null
        }
      })

      response.status(202).json({ started: true })
    })

    context.router.post('/updates/:printerId/upload/cancel', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
      const printerId = requireRouteParam(request.params.printerId, 'printerId')
      await assertTenantOwnsPrinter(printerId)
      const printerName = printerManager.getPrinter(printerId)?.name ?? printerId
      const state = stateFor(printerId)
      if (!isActiveUploadState(state)) {
        response.json(state)
        return
      }

      state.message = 'Cancelling firmware upload…'
      broadcast(printerId, state)
      uploadControllers.get(printerId)?.abort()

      annotateRequestAuditLog(request, {
        action: 'cancel-firmware-upload',
        resource: 'printer firmware',
        summary: `Cancelled the firmware upload to ${printerName}.`,
        metadata: {
          printerId,
          printerName
        }
      })

      response.status(202).json({ cancelled: true })
    })

    context.router.get('/updates/:printerId/upload/status', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
      const printerId = requireRouteParam(request.params.printerId, 'printerId')
      await assertTenantOwnsPrinter(printerId)
      response.json(await reconcileUploadState(printerId))
    })
  }
}

interface UpdateReport {
  printerId: string
  printerName: string
  model: string
  /** Whether the printer is currently reachable — firmware can only be uploaded when online. */
  online: boolean
  currentVersion: string | null
  sdCardPresent: boolean | null
  latestVersion: string | null
  updateAvailable: boolean
  downloadUrl: string | null
  releaseNotes: string | null
  /**
   * Installed firmware versions for the printer's sub-modules (each AMS unit,
   * controllers), excluding the main board (`ota`, already in `currentVersion`).
   * Display-only — Bambu ships these inside the main OTA package and publishes
   * no separate "latest" to compare against.
   */
  modules: Array<{
    name: string
    version: string
    hardwareVersion: string | null
    /** True for AMS units (`ams/0`, `ams/1`, ...) so the UI can group them. */
    isAms: boolean
  }>
  availableVersions: Array<{
    version: string
    fileAvailable: boolean
    releaseNotes: string | null
    releaseTime: string | null
  }>
}

/** AMS module names look like `ams/0`, `ams/1`, ... (and bare `ams`). */
function isAmsModuleName(name: string): boolean {
  return name === 'ams' || name.startsWith('ams/')
}
