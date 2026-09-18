/** Workspace validation and canonical ordering for calibration hardware targets. */
import { calibrationPrinterTargetSchema, type CalibrationPrinterTarget } from '@printstream/shared'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { badRequest } from '../../lib/http-error.js'

/** Canonical arrays keep equivalent selections identical for result deduplication. */
export async function validateCalibrationPrinterTarget(db: AnyPrismaClient, workspaceId: string, target: CalibrationPrinterTarget | undefined, model: string): Promise<CalibrationPrinterTarget> {
  const parsed = calibrationPrinterTargetSchema.parse(target ?? { scope: 'models', models: [model] })
  if (parsed.scope === 'models') return { scope: 'models', models: [...new Set(parsed.models)].sort() }
  const printerIds = [...new Set(parsed.printerIds)].sort()
  const rows = await db.printer.findMany({ where: { workspaceId, id: { in: printerIds } }, select: { id: true } })
  if (rows.length !== printerIds.length) throw badRequest('Every selected printer must belong to this workspace')
  return { scope: 'printers', printerIds }
}
