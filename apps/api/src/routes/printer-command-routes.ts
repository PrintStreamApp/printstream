/**
 * Live printer command and pressure-advance HTTP endpoints.
 *
 * Validates input and access before dispatch, then records successful mutations
 * in the request audit log. The parent router registers this pair before active
 * print objects and printer media endpoints.
 */
import type { Router } from 'express'
import { z } from 'zod'
import { hasBambuRfidTag, printerCommandSchema, printerPressureAdvanceProfilesResponseSchema, PRINTERS_MANAGE_AMS_SCOPE, extractErrorMessage } from '@printstream/shared'
import { saveSlotMaterial } from '../lib/slot-materials.js'
import { validateSlotMaterialCommand } from '../lib/slot-material-command.js'
import { slotFilamentResolvers } from '../lib/slot-filament-registry.js'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { prisma } from '../lib/prisma.js'
import { toPrinterDto } from '../lib/printer-record.js'
import { printerManager } from '../lib/printer-manager.js'
import { reconnectPrinter } from '../lib/printer-reconnect.js'
import { resolveRelevantPrintJobId } from '../lib/print-job-recorder.js'
import { badRequest, conflict, notFound } from '../lib/http-error.js'
import { assertRequestPermission, requireRequestPermission } from '../lib/authorization.js'
import { printGuards } from '../lib/print-guards.js'
import { calibrationOption } from '../lib/printer-calibration.js'
import { commandToMqttPayloads, resolvePressureAdvanceCommandContext } from '../lib/printer-command-payloads.js'
import { observePrinterSettingConfirmation } from '../lib/printer-setting-confirmation.js'
import { startCalibrationJob } from '../lib/calibration-jobs.js'
import { requireRouteParam } from '../lib/request-helpers.js'
import { describePrinterCommandAudit, describePrinterCommandAuditMetadata, getPrinterCommandPermission } from '../lib/printer-command-audit.js'
import { requireLiveControlConnection, validateCalibrationCommand, validatePrinterControlCommand } from '../lib/printer-command-policy.js'

const pressureAdvanceProfilesQuerySchema = z.object({
  amsId: z.coerce.number().int().min(0),
  slotId: z.coerce.number().int().min(0).max(15),
  filamentId: z.string().max(32).default('')
})

/** Register command routes at their original printer-router position. */
export function registerPrinterCommandRoutes(router: Router): void {
  router.post('/:id/command', async (request, response) => {
    const parsed = printerCommandSchema.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid command payload')
    }
    assertRequestPermission(request, getPrinterCommandPermission(parsed.data))
    const printerId = requireRouteParam(request.params.id, 'Printer id')
    const existing = await prisma.printer.findUnique({ where: { id: printerId } })
    if (!existing) throw notFound('Printer not found')
    const status = printerManager.getStatus(existing.id)
    const relatedJobId = await resolveRelevantPrintJobId(existing.id)

    if (parsed.data.type === 'calibrate') {
      validateCalibrationCommand(existing.model, parsed.data)
    }

    if (parsed.data.type === 'setAmsSlot' && parsed.data.materialIdentity) {
      const command = parsed.data
      const slot = status?.ams.find((unit) => unit.unitId === command.amsId)?.slots.find((tray) => tray.slot === command.slotId)
      if (!slot) throw badRequest('The AMS slot is no longer available')
      if (hasBambuRfidTag(slot.trayUuid)) throw badRequest('RFID filament details are read-only')
    }

    await validateSlotMaterialCommand(existing.workspaceId, existing.id, parsed.data)
    validatePrinterControlCommand(existing.model, status, parsed.data)

    if (parsed.data.type === 'calibrate') {
      const option = calibrationOption(parsed.data)
      if (option === 0) throw badRequest('At least one calibration option must be selected')
      const blocked = printGuards.evaluate({ printerId: existing.id, source: 'calibration' })
      if (blocked) throw conflict(blocked.reason ?? 'Calibration blocked by a plugin')
      const calibrationJobId = await startCalibrationJob({ printerId: existing.id, printerName: existing.name, option })
      if (!calibrationJobId) {
        throw badRequest('Printer is not connected: command was not delivered')
      }
      annotateRequestAuditLog(request, {
        action: 'start-calibration',
        resource: 'print job',
        summary: `Started calibration on ${existing.name}.`,
        metadata: {
          printerId: existing.id,
          printerName: existing.name,
          calibrationOption: option,
          jobId: calibrationJobId
        }
      })
      response.status(202).end()
      return
    }

    const payloads = commandToMqttPayloads(existing.model, parsed.data, status)
    const settingConfirmation = observePrinterSettingConfirmation(existing.id, parsed.data)
    if (payloads.length > 0) {
      let anySent = false
      for (const payload of payloads) {
        if (printerManager.publishCommand(existing.id, payload)) anySent = true
      }
      if (!anySent) {
        settingConfirmation?.cancel()
        if (parsed.data.type === 'refresh') {
          await reconnectPrinter(toPrinterDto(existing))
          response.status(202).end()
          return
        }
        throw badRequest('Printer is not connected: command was not delivered')
      }
    }
    if (settingConfirmation && !await settingConfirmation.promise) {
      console.warn(`[printer-setting] ${existing.name} did not confirm ${parsed.data.type}`)
      throw conflict('The printer did not confirm the setting change. Its previous value has been kept.')
    }
    const slotCommand = parsed.data
    if ((slotCommand.type === 'setAmsSlot' || slotCommand.type === 'setExternalSpool') && slotCommand.materialIdentity) {
      await slotFilamentResolvers.release({ workspaceId: existing.workspaceId, printerId: existing.id,
        amsId: slotCommand.amsId, slotId: slotCommand.type === 'setAmsSlot' ? slotCommand.slotId : null })
    }
    await saveSlotMaterial(existing.workspaceId, existing.id, slotCommand)
    if (['setAmsSlot', 'setExternalSpool', 'resetAmsSlot', 'resetExternalSpool', 'rescanAmsSlot'].includes(slotCommand.type)) {
      printerManager.refreshSlotMaterials(existing.id)
    }
    const commandAudit = describePrinterCommandAudit(parsed.data)
    if (commandAudit) {
      annotateRequestAuditLog(request, {
        action: commandAudit.action,
        resource: commandAudit.resource,
        summary: `${commandAudit.summary} on ${existing.name}.`,
        metadata: {
          printerId: existing.id,
          printerName: existing.name,
          jobId: relatedJobId,
          commandType: parsed.data.type,
          ...((parsed.data.type === 'setAmsSlot' || parsed.data.type === 'setExternalSpool')
            ? { manualMaterial: parsed.data.materialIdentity ?? null } : {}),
          ...describePrinterCommandAuditMetadata(parsed.data)
        }
      })
    }
    response.status(202).end()
  })

  router.get('/:id/pressure-advance-profiles', requireRequestPermission(PRINTERS_MANAGE_AMS_SCOPE), async (request, response) => {
    const parsed = pressureAdvanceProfilesQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid pressure-advance profile query')
    }

    const printerId = requireRouteParam(request.params.id, 'Printer id')
    const existing = await prisma.printer.findUnique({ where: { id: printerId } })
    if (!existing) throw notFound('Printer not found')

    const status = printerManager.getStatus(existing.id)
    requireLiveControlConnection(status, 'Pressure-advance profiles')
    const context = resolvePressureAdvanceCommandContext(status, parsed.data.amsId)

    try {
      const profiles = await printerManager.requestPressureAdvanceProfiles(existing.id, {
        filamentId: parsed.data.filamentId,
        extruderId: context.extruderId,
        nozzleDiameter: context.nozzleDiameter,
        nozzleTypeCode: context.nozzleTypeCode
      })
      response.json(printerPressureAdvanceProfilesResponseSchema.parse({ profiles }))
    } catch (error) {
      throw badRequest(extractErrorMessage(error, 'Unable to load pressure-advance profiles'))
    }
  })

}
