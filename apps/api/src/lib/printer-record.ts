/**
 * Printer-row serialization helpers.
 *
 * The database stores nozzle selections as a JSON string, while the API
 * and web app use typed DTO arrays.
 */
import type { Printer, PrinterNozzleDiameterSelection } from '@printstream/shared'

interface PrinterRowLike {
  id: string
  name: string
  host: string
  serial: string
  accessCode: string
  model: string
  bridgeId?: string | null
  currentPlateType?: string | null
  currentNozzleDiameters?: string | null
  position: number
  createdAt: Date
  updatedAt: Date
}

export function parseStoredPrinterNozzleDiameters(value: string | null | undefined): PrinterNozzleDiameterSelection[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    const selections = parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const extruderId = Number((entry as { extruderId?: unknown }).extruderId)
      const rawDiameter = (entry as { diameter?: unknown }).diameter
      if (!Number.isInteger(extruderId) || extruderId < 0) return []
      return [{
        extruderId,
        diameter: typeof rawDiameter === 'string' && /^\d+(?:\.\d+)?$/.test(rawDiameter) ? rawDiameter : null
      }]
    })

    return selections
      .sort((left, right) => left.extruderId - right.extruderId)
      .filter((entry, index, array) => index === array.findIndex((candidate) => candidate.extruderId === entry.extruderId))
  } catch {
    return []
  }
}

export function serializePrinterNozzleDiameters(value: readonly PrinterNozzleDiameterSelection[] | undefined): string {
  const normalized = (value ?? [])
    .filter((entry) => Number.isInteger(entry.extruderId) && entry.extruderId >= 0)
    .map((entry) => ({
      extruderId: entry.extruderId,
      diameter: typeof entry.diameter === 'string' && /^\d+(?:\.\d+)?$/.test(entry.diameter) ? entry.diameter : null
    }))
    .sort((left, right) => left.extruderId - right.extruderId)
    .filter((entry, index, array) => index === array.findIndex((candidate) => candidate.extruderId === entry.extruderId))

  return JSON.stringify(normalized)
}

/**
 * Server-internal printer DTO that carries the real LAN access code. Use this for
 * transport/manager paths. Never send the result to the browser — use
 * `toPublicPrinterDto` for anything that reaches an HTTP/WS response.
 */
export function toPrinterDto(row: PrinterRowLike): Printer {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    serial: row.serial,
    accessCode: row.accessCode,
    model: row.model as Printer['model'],
    bridgeId: row.bridgeId ?? null,
    currentPlateType: row.currentPlateType ?? null,
    currentNozzleDiameters: parseStoredPrinterNozzleDiameters(row.currentNozzleDiameters),
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

/**
 * Browser-facing printer DTO. Blanks the `accessCode` (the printer's LAN
 * credential) and reports only whether one is configured, so the secret never
 * leaves the server. The edit form treats access code as write-only: it shows a
 * blank field and only submits a new code when the operator types one. Every
 * HTTP/WS response that returns a printer must go through this, not `toPrinterDto`.
 */
export function toPublicPrinterDto(row: PrinterRowLike): Printer {
  return {
    ...toPrinterDto(row),
    accessCode: '',
    accessCodeConfigured: row.accessCode.length > 0
  }
}