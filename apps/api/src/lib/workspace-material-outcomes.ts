/**
 * Aggregates durable material snapshots for workspace reliability charts.
 * Only terminal jobs with a selected-plate material snapshot participate. The
 * JSON array is expanded inside PostgreSQL so the API never scans history rows
 * or re-opens source files on a Stats page request.
 */
import { Prisma } from '@prisma/client'
import type { WorkspaceMaterialOutcome } from '@printstream/shared'
import { prisma } from './prisma.js'
import type { StatsDateRange } from './stats-date-range.js'

type MaterialCountRow = {
  materialType: string
  result: string
  printCount: number
}

/** Return one outcome count per material type, scoped by workspace in the SQL itself. */
export async function readWorkspaceMaterialOutcomes(workspaceId: string, range?: StatsDateRange | null): Promise<WorkspaceMaterialOutcome[]> {
  const rows = await prisma.$queryRaw<MaterialCountRow[]>(Prisma.sql`
    SELECT material.value AS "materialType", job."result", COUNT(*)::integer AS "printCount"
    FROM "PrintJob" AS job
    CROSS JOIN LATERAL jsonb_array_elements_text(job."materialTypesJson"::jsonb) AS material(value)
    WHERE job."workspaceId" = ${workspaceId}
      AND job."finishedAt" IS NOT NULL
      AND job."materialTypesJson" IS NOT NULL
      AND job."result" IN ('success', 'failed', 'cancelled')
      ${range ? Prisma.sql`AND job."finishedAt" >= ${range.from} AND job."finishedAt" < ${range.until}` : Prisma.empty}
    GROUP BY material.value, job."result"
  `)

  return foldMaterialOutcomeRows(rows)
}

/** Fold the three terminal result rows into each material's chart entry. */
export function foldMaterialOutcomeRows(rows: readonly MaterialCountRow[]): WorkspaceMaterialOutcome[] {
  const byMaterial = new Map<string, WorkspaceMaterialOutcome>()
  for (const row of rows) {
    let outcome = byMaterial.get(row.materialType)
    if (!outcome) {
      outcome = { materialType: row.materialType, successfulPrints: 0, failedPrints: 0, cancelledPrints: 0 }
      byMaterial.set(row.materialType, outcome)
    }
    if (row.result === 'success') outcome.successfulPrints += row.printCount
    if (row.result === 'failed') outcome.failedPrints += row.printCount
    if (row.result === 'cancelled') outcome.cancelledPrints += row.printCount
  }
  return [...byMaterial.values()].sort((left, right) => left.materialType.localeCompare(right.materialType))
}
