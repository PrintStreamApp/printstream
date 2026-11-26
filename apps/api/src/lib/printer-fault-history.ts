/**
 * Reads tenant-scoped fault history for Jobs. Occurrences are independent of job
 * deletion; an orphan without an idle reference becomes a standalone history card.
 * Counterparts: shared printer-faults contract and web PrinterFaultDetails.
 */
import type { Prisma } from '@prisma/client'
import { printerFaultSchema, type PrinterFault, type PrinterFaultHistory } from '@printstream/shared'
import { visibleFaultIdlePeriods } from './printer-fault-periods.js'
import { prisma } from './prisma.js'
import { badRequest, notFound } from './http-error.js'

type FaultRow = Prisma.PrinterFaultGetPayload<{ include: { gaps: true } }>

/** The message is a historical snapshot; source uncertainty depends only on persisted gaps. */
export function toPrinterFaultDto(row: FaultRow, alreadyPresent = false): PrinterFault {
  let state: PrinterFault['state'] = 'active'
  if (row.observedClearedAt) state = 'cleared'
  else if (row.gaps.some((gap) => !gap.endedAt)) state = 'uncertain'

  return printerFaultSchema.parse({
    id: row.id, source: row.source, code: row.code, message: row.message,
    firstObservedAt: row.firstObservedAt.toISOString(),
    lastObservedAt: row.lastObservedAt.toISOString(),
    observedClearedAt: row.observedClearedAt?.toISOString() ?? null,
    state,
    alreadyPresent,
    gaps: row.gaps.map((gap) => ({
      startedAt: gap.startedAt.toISOString(), endedAt: gap.endedAt?.toISOString() ?? null, reason: gap.reason
    }))
  })
}

/** Batch job details to avoid a query per active/finished card. Legacy rows have an empty set. */
export async function readJobFaults(workspaceId: string, jobIds: string[]): Promise<Map<string, PrinterFault[]>> {
  if (!jobIds.length) return new Map()
  const links = await prisma.printJobFault.findMany({ where: { workspaceId, jobId: { in: jobIds } }, include: {
    fault: { include: { gaps: { where: { workspaceId }, orderBy: { startedAt: 'asc' } } } }
  }, orderBy: { fault: { firstObservedAt: 'asc' } } })
  const byJob = new Map<string, PrinterFault[]>()
  for (const link of links) {
    const faults = byJob.get(link.jobId) ?? []
    faults.push(toPrinterFaultDto(link.fault, link.alreadyPresent))
    byJob.set(link.jobId, faults)
  }
  return byJob
}

/** Read idle references and retained orphan history before the shared merge/filter/page operation. */
export async function readStandaloneFaultHistory(workspaceId: string): Promise<PrinterFaultHistory[]> {
  const faults = await prisma.printerFault.findMany({ where: { workspaceId }, include: {
    printer: { select: { name: true } },
    gaps: { where: { workspaceId }, orderBy: { startedAt: 'asc' } },
    idlePeriods: { where: { workspaceId }, orderBy: { startedAt: 'asc' } },
    jobSpans: { where: { workspaceId } },
    _count: { select: { jobs: true } }
  } })
  return faults.flatMap((fault) => {
    const dto = toPrinterFaultDto(fault)
    const visible = visibleFaultIdlePeriods(fault.idlePeriods, fault.jobSpans)
    const periods = [...visible]
    if (!periods.length && fault._count.jobs === 0) {
      periods.push({ id: `orphan:${fault.id}`, startedAt: fault.firstObservedAt, endedAt: fault.observedClearedAt })
    }
    return periods.map((period) => ({
      id: period.id, printerId: fault.printerId, printerName: fault.printer.name,
      startedAt: period.startedAt.toISOString(), endedAt: period.endedAt?.toISOString() ?? null,
      fault: { ...dto, alreadyPresent: period.startedAt > fault.firstObservedAt }
    }))
  })
}

/** Delete only a cleared occurrence atomically; this never sends a printer command. */
export async function deleteClearedPrinterFault(workspaceId: string, id: string): Promise<void> {
  const fault = await prisma.printerFault.findFirst({ where: { workspaceId, id }, select: { id: true } })
  if (!fault) throw notFound('Printer fault not found')
  const deleted = await prisma.printerFault.deleteMany({ where: {
    workspaceId, id, observedClearedAt: { not: null }, gaps: { none: { endedAt: null } }
  } })
  if (!deleted.count) throw badRequest('Only cleared printer faults can be deleted. Active or uncertain occurrences must be retained.')
}
