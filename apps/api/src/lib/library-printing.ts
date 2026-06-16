/**
 * Shared library-print entrypoint.
 *
 * Core routes and plugins both need the same validation pipeline before
 * a library file is handed to the dispatcher: resolve the file on disk,
 * verify the target printer is connected, enforce plugin print guards,
 * and run plate/filament compatibility checks. Centralizing that logic
 * keeps new print entrypoints aligned with the existing library route.
 */
import type { PrintDispatchJob, PrintFromLibrary } from '@printstream/shared'
import { printerModelSchema } from '@printstream/shared'
import { getPrintSourceKind, printDispatcher } from './print-dispatcher.js'
import { badRequest, conflict, HttpError, notFound } from './http-error.js'
import { isDirectPrintableFileName } from '@printstream/shared'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { prisma } from './prisma.js'
import { printerManager } from './printer-manager.js'
import { readLibraryThreeMfIndex } from './library-three-mf.js'
import { printGuards } from './print-guards.js'
import { assertLibraryPrintCompatibilityForIndex } from './print-filament-compatibility.js'
import { ensureLibrarySnapshotRecord, type SnapshotLibraryFile } from './print-file-snapshots.js'
import { visibleLibraryFilesWhere } from './library-visibility.js'

export interface LibraryPrintSource extends SnapshotLibraryFile {
  fileId: string
}

interface LibraryFilePrintRow extends SnapshotLibraryFile {
  fileId?: string
  tenantId: string
  folderId: string | null
  hidden: boolean
}

export async function enqueueLibraryPrint(input: PrintFromLibrary, tenantId: string): Promise<PrintDispatchJob> {
  const file = await prisma.libraryFile.findFirst({ where: { id: input.fileId, tenantId } })
  if (!file) throw notFound('File not found')
  return enqueueLibraryPrintSource(input, toLibraryPrintSource(await resolveConnectedLibrarySource(file)))
}

async function resolveConnectedLibrarySource(file: LibraryFilePrintRow): Promise<LibraryFilePrintRow> {
  if (!file.ownerBridgeId || bridgeSessionManager.isConnected(file.ownerBridgeId)) return file

  const candidates = await prisma.libraryFile.findMany({
    where: visibleLibraryFilesWhere({
      tenantId: file.tenantId,
      folderId: file.folderId,
      name: file.name,
      kind: file.kind,
      ownerBridgeId: { not: null }
    }),
    orderBy: { uploadedAt: 'desc' }
  }) as LibraryFilePrintRow[]
  const connectedCandidates = candidates.filter((candidate) => {
    return candidate.id !== file.id
      && candidate.ownerBridgeId != null
      && bridgeSessionManager.isConnected(candidate.ownerBridgeId)
  })

  const connectedCandidate = connectedCandidates[0]
  if (connectedCandidates.length === 1 && connectedCandidate) return connectedCandidate

  const sameSizeCandidates = connectedCandidates.filter((candidate) => candidate.sizeBytes === file.sizeBytes)
  const sameSizeCandidate = sameSizeCandidates[0]
  if (sameSizeCandidates.length === 1 && sameSizeCandidate) return sameSizeCandidate

  return file
}

function toLibraryPrintSource(file: LibraryFilePrintRow): LibraryPrintSource {
  return {
    fileId: file.fileId ?? file.id,
    tenantId: file.tenantId,
    name: file.name,
    ownerBridgeId: file.ownerBridgeId,
    storedPath: file.storedPath,
    sizeBytes: file.sizeBytes,
    kind: file.kind,
    snapshotKey: file.snapshotKey,
    id: file.id
  }
}

export async function enqueueLibraryPrintSource(
  input: PrintFromLibrary,
  source: LibraryPrintSource
): Promise<PrintDispatchJob> {
  if (!isDirectPrintableFileName(source.name)) {
    throw badRequest('Only .gcode or .gcode.3mf files can be printed directly')
  }

  const printer = await prisma.printer.findFirst({ where: { id: input.printerId, tenantId: source.tenantId } })
  if (!printer) throw notFound('Printer not found')
  if (!printerManager.getPrinter(printer.id)) throw notFound('Printer not found or not connected')

  const blocked = printGuards.evaluate({ printerId: printer.id, source: 'dispatch' })
  if (blocked) throw conflict(blocked.reason ?? 'Print blocked by a plugin')

  const sourceKind = getPrintSourceKind(source.name)
  let index = null
  if (sourceKind === '3mf') {
    try {
      index = await readLibraryThreeMfIndex(source)
    } catch {
      throw notFound('File missing on bridge')
    }

    const printerModel = printerModelSchema.safeParse(printer.model)
    assertLibraryPrintCompatibilityForIndex(index, {
      plate: input.plate,
      printerModel: printerModel.success ? printerModel.data : 'unknown',
      printerStatus: printerManager.getStatus(printer.id),
      amsMapping: input.amsMapping,
      allowIncompatibleFilament: input.allowIncompatibleFilament,
      allowPlateTypeMismatch: input.allowPlateTypeMismatch,
      currentPlateType: input.currentPlateType,
      currentNozzleDiameters: input.currentNozzleDiameters
    })
  }

  try {
    const plateName = resolveRequestedPlateName(source.name, index, input.plate)
    const snapshot = await ensureLibrarySnapshotRecord({
      id: source.id,
      tenantId: source.tenantId,
      name: source.name,
      ownerBridgeId: source.ownerBridgeId,
      storedPath: source.storedPath,
      sizeBytes: source.sizeBytes,
      kind: source.kind,
      snapshotKey: source.snapshotKey
    })
    return await printDispatcher.enqueueSnapshotPrint({
      ...input,
      fileName: source.name,
      snapshot,
      plateName,
      isMultiPlate: index ? index.plates.length > 1 : true
    }, printer)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw badRequest((error as Error).message || 'Failed to enqueue print')
  }
}

function resolveRequestedPlateName(
  fileName: string,
  index: Awaited<ReturnType<typeof readLibraryThreeMfIndex>> | null,
  plate: number
): string | null {
  if (getPrintSourceKind(fileName) !== '3mf') return null
  return index?.plates.find((entry) => entry.index === plate)?.name?.trim() || null
}