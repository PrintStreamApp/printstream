/**
 * HTTP routes for the calibration plugin, mounted at `/api/plugins/calibration`.
 * Reads use `printers.view`; run/print/save mutations use `printers.control`
 * (they dispatch prints and printer commands). Handlers stay thin, orchestration
 * lives in `run-manager.ts`, data access in `store.ts`.
 */
import {
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  isAutomaticPressureAdvance,
  calibrationPrinterTargetSchema,
  createCalibrationRunSchema,
  manualCalibrationResultSchema,
  saveCalibrationResultSchema,
  submitCalibrationMeasurementSchema
} from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../../lib/request-helpers.js'
import { toCalibrationResultDto, toCalibrationRunDto, toCalibrationRunParameters } from './dto.js'
import { deleteResult, deleteRun, getRun, listResults, listRuns } from './store.js'
import { printRun, saveRunResult, startRun, submitMeasurement, syncSliceStatus, type CalibrationRunManagerDeps } from './run-manager.js'
import { saveManualResult } from './manual-result.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import type { AutomaticPaRuns } from './automatic-pa.js'

export function registerCalibrationRoutes(context: ApiPluginContext, deps: CalibrationRunManagerDeps, automatic: AutomaticPaRuns): void {
  const { router, prisma } = context

  router.get('/runs', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const rows = await listRuns(prisma, workspaceId)
    const synced = await Promise.all(rows.map((row) => syncSliceStatus(prisma, workspaceId, row)))
    response.json({ runs: synced.map(toCalibrationRunDto) })
  })

  router.post('/runs', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const parsed = createCalibrationRunSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid calibration request')
    const workspaceId = requireRequestWorkspaceId(request)
    const workspace = request.workspace ?? { id: workspaceId, slug: workspaceId, name: workspaceId }
    const run = isAutomaticPressureAdvance(parsed.data.parameters)
      ? await automatic.prepare(prisma, workspaceId, parsed.data)
      : await startRun(deps, prisma, workspaceId, workspace, parsed.data)
    annotateRequestAuditLog(request, {
      action: 'start-calibration',
      resource: 'calibration run',
      summary: `Started a ${parsed.data.parameters.kind} calibration.`,
      metadata: { runId: run.id, printerId: parsed.data.printerId, kind: parsed.data.parameters.kind }
    })
    response.status(202).json({ run: toCalibrationRunDto(run) })
  })

  router.get('/runs/:id', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const run = await getRun(prisma, workspaceId, requireRouteParam(request.params.id, 'Calibration run id'))
    if (!run) throw notFound('Calibration run not found')
    response.json({ run: toCalibrationRunDto(await syncSliceStatus(prisma, workspaceId, run)) })
  })

  router.post('/runs/:id/print', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const runId = requireRouteParam(request.params.id, 'Calibration run id')
    const run = await getRun(prisma, workspaceId, runId)
    if (!run) throw notFound('Calibration run not found')
    if (isAutomaticPressureAdvance(toCalibrationRunParameters(run))) {
      await automatic.start(prisma, workspaceId, run)
    } else {
      await printRun(deps, prisma, workspaceId, runId)
    }
    annotateRequestAuditLog(request, { action: 'print-calibration', resource: 'calibration run', summary: 'Dispatched a calibration print.', metadata: { runId } })
    response.status(202).json({ run: toCalibrationRunDto((await getRun(prisma, workspaceId, runId))!) })
  })

  router.post('/runs/:id/measurement', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const parsed = submitCalibrationMeasurementSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid measurement')
    const workspaceId = requireRequestWorkspaceId(request)
    const runId = requireRouteParam(request.params.id, 'Calibration run id')
    const run = await getRun(prisma, workspaceId, runId)
    if (!run) throw notFound('Calibration run not found')
    const parameters = toCalibrationRunParameters(run)
    const value = await submitMeasurement(prisma, workspaceId, runId, parsed.data.measurement, parameters)
    annotateRequestAuditLog(request, { action: 'record-calibration-measurement', resource: 'calibration run', summary: 'Recorded a calibration measurement.', metadata: { runId } })
    response.json({ run: toCalibrationRunDto((await getRun(prisma, workspaceId, runId))!), value })
  })

  router.post('/runs/:id/save', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const parsed = saveCalibrationResultSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid save request')
    const workspaceId = requireRequestWorkspaceId(request)
    const runId = requireRouteParam(request.params.id, 'Calibration run id')
    await saveRunResult(deps, prisma, workspaceId, runId, parsed.data)
    annotateRequestAuditLog(request, { action: 'save-calibration', resource: 'calibration result', summary: 'Saved a calibration result.', metadata: { runId, scope: parsed.data.scope } })
    response.json({ run: toCalibrationRunDto((await getRun(prisma, workspaceId, runId))!) })
  })

  router.delete('/runs/:id', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const runId = requireRouteParam(request.params.id, 'Calibration run id')
    const run = await getRun(prisma, workspaceId, runId)
    if (run?.status === 'printing' && isAutomaticPressureAdvance(toCalibrationRunParameters(run))) {
      throw badRequest('Stop the calibration on the printer before deleting its run')
    }
    await deleteRun(prisma, workspaceId, runId)
    annotateRequestAuditLog(request, { action: 'delete-calibration-run', resource: 'calibration run', summary: 'Deleted a calibration run.', metadata: { runId } })
    response.status(204).end()
  })

  router.get('/results', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const rows = await listResults(prisma, workspaceId)
    response.json({ results: rows.map(toCalibrationResultDto) })
  })

  router.post('/results', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const parsed = manualCalibrationResultSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid calibration value')
    const rows = await saveManualResult(prisma, requireRequestWorkspaceId(request), parsed.data)
    annotateRequestAuditLog(request, {
      action: 'save-manual-calibration', resource: 'calibration result',
      summary: 'Saved a manually entered calibration.',
      metadata: { kind: parsed.data.calibration.kind, resultIds: rows.map((row) => row.id) }
    })
    response.status(201).json({ results: rows.map(toCalibrationResultDto) })
  })

  router.delete('/results/:id', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const resultId = requireRouteParam(request.params.id, 'Calibration result id')
    await deleteResult(prisma, workspaceId, resultId)
    annotateRequestAuditLog(request, { action: 'delete-calibration-result', resource: 'calibration result', summary: 'Deleted a saved calibration.', metadata: { resultId } })
    response.status(204).end()
  })

  router.put('/results/:id', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const parsed = manualCalibrationResultSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid calibration value')
    const workspaceId = requireRequestWorkspaceId(request)
    const id = requireRouteParam(request.params.id, 'Calibration result id')
    // Replace the selected rule atomically. A scope change must not leave the old rule active.
    const rows = await prisma.$transaction(async (transaction) => {
      const existing = await transaction.calibrationResult.findFirst({ where: { id, workspaceId } })
      if (!existing) throw notFound('Calibration result not found')
      if (existing.runId && parsed.data.calibration.kind !== existing.kind) {
        throw badRequest('The calibration type must match its source run')
      }
      const input = parsed.data
      // Legacy clients must not broaden an existing exact-printer rule while editing its value.
      input.target.printerTarget ??= existing.printerTargetJson == null
        ? { scope: 'models', models: [existing.printerModel] }
        : calibrationPrinterTargetSchema.parse(existing.printerTargetJson)
      if (input.calibration.kind === 'pressureAdvance' && existing.kind === 'pressureAdvance') {
        const existingMode = existing.pressureAdvanceMode === 'linear' ? 'linear' : 'native'
        const requestedMode = input.calibration.pressureAdvanceMode ?? existingMode
        if (existing.runId && requestedMode !== existingMode) {
          throw badRequest('The compensation mode must match its source run')
        }
        // Older clients omit mode. Editing a value must not silently reinterpret its K.
        input.calibration.pressureAdvanceMode = requestedMode
      }
      await transaction.calibrationResult.deleteMany({ where: { id, workspaceId } })
      return saveManualResult(transaction as AnyPrismaClient, workspaceId, input, existing.runId)
    })
    annotateRequestAuditLog(request, {
      action: 'edit-calibration', resource: 'calibration result',
      summary: 'Updated a saved calibration.', metadata: { resultId: id }
    })
    response.json({ results: rows.map(toCalibrationResultDto) })
  })
}
