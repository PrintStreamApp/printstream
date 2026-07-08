/**
 * HTTP routes for the calibration plugin, mounted at `/api/plugins/calibration`.
 * Reads use `printers.view`; run/print/save mutations use `printers.control`
 * (they dispatch prints and printer commands). Handlers stay thin — orchestration
 * lives in `run-manager.ts`, data access in `store.ts`.
 */
import {
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  createCalibrationRunSchema,
  saveCalibrationResultSchema,
  submitCalibrationMeasurementSchema
} from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireRequestTenantId, requireRouteParam } from '../../lib/request-helpers.js'
import { toCalibrationResultDto, toCalibrationRunDto, toCalibrationRunParameters } from './dto.js'
import { deleteResult, deleteRun, getRun, listResults, listRuns } from './store.js'
import { printRun, saveRunResult, startRun, submitMeasurement, syncSliceStatus, type CalibrationRunManagerDeps } from './run-manager.js'

export function registerCalibrationRoutes(context: ApiPluginContext, deps: CalibrationRunManagerDeps): void {
  const { router, prisma } = context

  router.get('/runs', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const rows = await listRuns(prisma, tenantId)
    const synced = await Promise.all(rows.map((row) => syncSliceStatus(prisma, tenantId, row)))
    response.json({ runs: synced.map(toCalibrationRunDto) })
  })

  router.post('/runs', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const parsed = createCalibrationRunSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid calibration request')
    const tenantId = requireRequestTenantId(request)
    const tenant = request.tenant ?? { id: tenantId, slug: tenantId, name: tenantId }
    const run = await startRun(deps, prisma, tenantId, tenant, parsed.data)
    annotateRequestAuditLog(request, {
      action: 'start-calibration',
      resource: 'calibration run',
      summary: `Started a ${parsed.data.parameters.kind === 'flowRatio' ? 'flow ratio' : 'pressure advance'} calibration.`,
      metadata: { runId: run.id, printerId: parsed.data.printerId, kind: parsed.data.parameters.kind }
    })
    response.status(202).json({ run: toCalibrationRunDto(run) })
  })

  router.get('/runs/:id', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const run = await getRun(prisma, tenantId, requireRouteParam(request.params.id, 'Calibration run id'))
    if (!run) throw notFound('Calibration run not found')
    response.json({ run: toCalibrationRunDto(await syncSliceStatus(prisma, tenantId, run)) })
  })

  router.post('/runs/:id/print', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const runId = requireRouteParam(request.params.id, 'Calibration run id')
    await printRun(prisma, tenantId, runId)
    annotateRequestAuditLog(request, { action: 'print-calibration', resource: 'calibration run', summary: 'Dispatched a calibration print.', metadata: { runId } })
    response.status(202).json({ run: toCalibrationRunDto((await getRun(prisma, tenantId, runId))!) })
  })

  router.post('/runs/:id/measurement', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const parsed = submitCalibrationMeasurementSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid measurement')
    const tenantId = requireRequestTenantId(request)
    const runId = requireRouteParam(request.params.id, 'Calibration run id')
    const run = await getRun(prisma, tenantId, runId)
    if (!run) throw notFound('Calibration run not found')
    const parameters = toCalibrationRunParameters(run)
    const value = await submitMeasurement(prisma, tenantId, runId, parsed.data.measurement, parameters)
    response.json({ run: toCalibrationRunDto((await getRun(prisma, tenantId, runId))!), value })
  })

  router.post('/runs/:id/save', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const parsed = saveCalibrationResultSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid save request')
    const tenantId = requireRequestTenantId(request)
    const runId = requireRouteParam(request.params.id, 'Calibration run id')
    await saveRunResult(deps, prisma, tenantId, runId, parsed.data)
    annotateRequestAuditLog(request, { action: 'save-calibration', resource: 'calibration result', summary: 'Saved a calibration result.', metadata: { runId, scope: parsed.data.scope } })
    response.json({ run: toCalibrationRunDto((await getRun(prisma, tenantId, runId))!) })
  })

  router.delete('/runs/:id', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const runId = requireRouteParam(request.params.id, 'Calibration run id')
    await deleteRun(prisma, tenantId, runId)
    response.status(204).end()
  })

  router.get('/results', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const rows = await listResults(prisma, tenantId)
    response.json({ results: rows.map(toCalibrationResultDto) })
  })

  router.delete('/results/:id', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    await deleteResult(prisma, tenantId, requireRouteParam(request.params.id, 'Calibration result id'))
    response.status(204).end()
  })
}
