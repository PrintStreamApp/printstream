/**
 * Library file persistence helpers shared by uploads and generated artifacts.
 *
 * Bytes are stored through the bridge-backed library path, while metadata
 * and overwrite/version behavior stay centralized here.
 */
import type { Request } from 'express'
import { classifyLibraryFileKind } from '@printstream/shared'
import { annotateRequestAuditLog } from './audit-logs.js'
import { badRequest, notFound } from './http-error.js'
import { prisma } from './prisma.js'
import { broadcastLibraryChanged } from './ws-resource-events.js'
import { deleteBridgeLibraryFile, deleteLibraryFileBytes, storeBridgeLibraryFile } from './bridge-library-files.js'
import { resolveRequestActorAttribution } from './actor-attribution.js'
import { visibleLibraryFilesWhere } from './library-visibility.js'

type PersistedLibraryFileRow = Awaited<ReturnType<typeof prisma.libraryFile.create>>

type LibraryOverwriteTarget = {
  id: string
  tenantId: string
  name: string
  ownerBridgeId?: string | null
  sizeBytes: number
  uploadedAt: Date
  kind: string
  storedPath: string
  thumbnailPath: string | null
  folderId: string | null
  currentVersionNumber: number
  createdById: string | null
  createdByName: string | null
  restoredFromVersionNumber: number | null
}

export async function persistLibraryFileFromLocalPath(input: {
  tenantId: string
  sourcePath: string
  fileName: string
  sizeBytes: number
  folderId: string | null
  bridgeId: string | null
  hidden: boolean
  request?: Request
  auditAction?: 'upload' | 'slice'
  /** Lifecycle origin override; defaults from `auditAction` ('slice' or 'upload'). */
  origin?: 'upload' | 'slice' | 'scaffold'
  missingBridgeMessage?: string
  onBridgeProgress?: (transferredBytes: number) => Promise<void> | void
  onBridgeComplete?: () => Promise<void> | void
}): Promise<PersistedLibraryFileRow> {
  const attribution = await resolveRequestActorAttribution(input.request)
  // Lifecycle origin drives cleanup windows (unsaved sliced outputs age out
  // faster than transient uploads).
  const origin = input.origin ?? (input.auditAction === 'slice' ? 'slice' : 'upload')
  const parentFolder = input.folderId
    ? await prisma.libraryFolder.findUnique({ where: { id: input.folderId }, select: { ownerBridgeId: true } })
    : null
  if (input.folderId && !parentFolder?.ownerBridgeId) {
    throw notFound('Folder not found')
  }
  const ownerBridgeId = parentFolder?.ownerBridgeId ?? input.bridgeId
  if (!ownerBridgeId) {
    throw badRequest(input.missingBridgeMessage ?? 'Select a bridge before saving to the library')
  }

  const overwriteTarget = !input.hidden
    ? await findLibraryOverwriteTarget({
      tenantId: input.tenantId,
      ownerBridgeId,
      folderId: input.folderId,
      name: input.fileName
    })
    : null
  const storedPath = buildLibraryStoredPath(input.fileName)
  await storeBridgeLibraryFile(ownerBridgeId, storedPath, input.sourcePath, { onProgress: input.onBridgeProgress })
  await input.onBridgeComplete?.()

  let created: PersistedLibraryFileRow
  const uploadedAt = new Date()
  try {
    if (overwriteTarget) {
      created = await prisma.$transaction(async (tx) => {
        await tx.libraryFileVersion.create({
          data: toLibraryFileVersionCreateInput(overwriteTarget)
        })
        return await tx.libraryFile.update({
          where: { id: overwriteTarget.id },
          data: {
            name: input.fileName,
            storedPath,
            sizeBytes: input.sizeBytes,
            kind: classifyLibraryFileKind(input.fileName),
            folderId: input.folderId,
            uploadedAt,
            currentVersionNumber: overwriteTarget.currentVersionNumber + 1,
            thumbnailPath: null,
            snapshotKey: null,
            createdById: attribution.createdById,
            createdByName: attribution.createdByName,
            // Fresh content replaces whatever the previous version's
            // provenance was.
            restoredFromVersionNumber: null
          }
        })
      })
    } else {
      created = await prisma.libraryFile.create({
        data: {
          tenantId: input.tenantId,
          ownerBridgeId,
          name: input.fileName,
          storedPath,
          sizeBytes: input.sizeBytes,
          kind: classifyLibraryFileKind(input.fileName),
          folderId: input.hidden ? null : input.folderId,
          hidden: input.hidden,
          uploadedAt,
          origin,
          createdById: attribution.createdById,
          createdByName: attribution.createdByName
        }
      })
    }
  } catch (error) {
    await deleteBridgeLibraryFile(ownerBridgeId, storedPath).catch(() => undefined)
    throw error
  }

  if (input.request) {
    const action = input.auditAction ?? 'upload'
    annotateRequestAuditLog(input.request, {
      action: overwriteTarget ? 'overwrite' : action,
      resource: 'library file',
      summary: overwriteTarget
        ? `Overwrote library file ${created.name}.`
        : action === 'slice'
          ? `Saved sliced library file ${created.name}.`
          : `Uploaded library file ${created.name}.`,
      metadata: {
        fileId: created.id,
        fileName: created.name,
        folderId: created.folderId,
        hidden: created.hidden,
        sizeBytes: created.sizeBytes,
        overwrittenVersionNumber: overwriteTarget?.currentVersionNumber ?? null
      }
    })
  }
  if (!input.hidden) broadcastLibraryChanged()
  return created
}

/**
 * Resolve — creating as needed — a chain of nested folders below `baseFolderId`
 * and return the deepest folder's id. Used by folder-structure uploads, where
 * the client sends each file's folder path relative to the upload destination.
 * Folders are metadata-only (file bytes stay flat on the bridge), so this only
 * touches `LibraryFolder` rows. A concurrent upload creating the same segment
 * loses the unique-constraint race and re-reads the winner's row.
 */
export async function ensureLibraryFolderPath(input: {
  tenantId: string
  bridgeId: string | null
  baseFolderId: string | null
  segments: string[]
}): Promise<string | null> {
  if (input.segments.length === 0) return input.baseFolderId
  const baseFolder = input.baseFolderId
    ? await prisma.libraryFolder.findUnique({ where: { id: input.baseFolderId }, select: { ownerBridgeId: true } })
    : null
  if (input.baseFolderId && !baseFolder?.ownerBridgeId) throw notFound('Folder not found')
  const ownerBridgeId = baseFolder?.ownerBridgeId ?? input.bridgeId
  if (!ownerBridgeId) throw badRequest('Select a bridge before uploading folders to the library')

  let parentId = input.baseFolderId
  let createdAny = false
  for (const segment of input.segments) {
    const name = segment.trim()
    if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw badRequest('Upload contains an invalid folder name')
    }
    const where = { tenantId: input.tenantId, ownerBridgeId, parentId, name }
    let folder = await prisma.libraryFolder.findFirst({ where, select: { id: true } })
    if (!folder) {
      try {
        folder = await prisma.libraryFolder.create({ data: where, select: { id: true } })
        createdAny = true
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        folder = await prisma.libraryFolder.findFirst({ where, select: { id: true } })
        if (!folder) throw error
      }
    }
    parentId = folder.id
  }
  if (createdAny) broadcastLibraryChanged()
  return parentId
}

type FolderTreeFileRow = {
  id: string
  name: string
  hidden: boolean
}

/**
 * Delete a folder and everything beneath it: descendant folder rows are
 * removed, and the contained files move to the recycle bin (soft delete —
 * bytes and version history stay restorable until the bin's retention
 * window expires). Rows change in one transaction: the file→folder FK is
 * SetNull, so the recycled files' folder pointers clear together with the
 * folder rows instead of stranding files at the root mid-delete.
 *
 * `assertFileDeletable` runs against every contained file before anything is
 * touched, so callers can veto the whole tree (e.g. demo-mode protection).
 */
export async function deleteLibraryFolderTree(
  folderId: string,
  options?: { assertFileDeletable?: (row: { name: string; hidden: boolean }) => void }
): Promise<{ deletedFiles: number }> {
  // Collect the subtree breadth-first; folder trees are small and acyclic.
  const subtreeIds = [folderId]
  let frontier = [folderId]
  while (frontier.length > 0) {
    const children = await prisma.libraryFolder.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true }
    })
    frontier = children.map((child) => child.id)
    subtreeIds.push(...frontier)
  }

  const rows = await prisma.libraryFile.findMany({
    where: { folderId: { in: subtreeIds } },
    select: { id: true, name: true, hidden: true }
  }) as FolderTreeFileRow[]
  for (const row of rows) {
    options?.assertFileDeletable?.(row)
  }

  await prisma.$transaction([
    prisma.libraryFile.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { deletedAt: new Date() }
    }),
    // Cascades to descendant folder rows via the parent FK.
    prisma.libraryFolder.delete({ where: { id: folderId } })
  ])
  broadcastLibraryChanged()

  return { deletedFiles: rows.length }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
  )
}

function buildLibraryStoredPath(fileName: string): string {
  const safe = fileName.replace(/[^\w.-]+/g, '_')
  return `${Date.now()}-${safe}`
}

async function findLibraryOverwriteTarget(input: {
  tenantId: string
  ownerBridgeId: string
  folderId: string | null
  name: string
}): Promise<LibraryOverwriteTarget | null> {
  return await prisma.libraryFile.findFirst({
    where: visibleLibraryFilesWhere({
      tenantId: input.tenantId,
      ownerBridgeId: input.ownerBridgeId,
      folderId: input.folderId,
      name: input.name
    }),
    orderBy: { uploadedAt: 'desc' }
  }) as LibraryOverwriteTarget | null
}

function toLibraryFileVersionCreateInput(row: LibraryOverwriteTarget) {
  return {
    tenantId: row.tenantId,
    libraryFileId: row.id,
    ownerBridgeId: row.ownerBridgeId,
    folderId: row.folderId,
    name: row.name,
    storedPath: row.storedPath,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
    thumbnailPath: row.thumbnailPath,
    uploadedAt: row.uploadedAt,
    versionNumber: row.currentVersionNumber,
    createdById: row.createdById,
    createdByName: row.createdByName,
    restoredFromVersionNumber: row.restoredFromVersionNumber
  }
}

/**
 * Make a previously-hidden sliced output visible in the library (the user chose to
 * keep a gcode produced by a "slice without saving" run).
 *
 * When a visible file with the same name already exists at the destination, the
 * save REPLACES it with upload-overwrite semantics: the existing row keeps its
 * identity (links, order templates, and version history stay valid), its
 * previous content is archived as a version, and the hidden output row folds
 * into it. Callers holding the output's file id must switch to the returned id.
 */
export async function unhideSlicedOutput(
  fileId: string,
  options?: { folderId?: string | null; name?: string }
): Promise<{ id: string; name: string; replacedExisting: boolean }> {
  const output = await prisma.libraryFile.findUnique({ where: { id: fileId } })
  if (!output) throw notFound('File not found')

  // folderId is a logical (DB-only) pointer and the bridge stores files flat by
  // storedPath, so moving/renaming the kept output is a pure metadata update.
  const folderId = options && Object.prototype.hasOwnProperty.call(options, 'folderId')
    ? options.folderId ?? null
    : output.folderId
  const trimmedName = options?.name?.trim()
  const name = trimmedName
    ? (trimmedName.toLowerCase().endsWith('.3mf') ? trimmedName : `${trimmedName}.gcode.3mf`)
    : output.name

  const existing = output.ownerBridgeId
    ? await findLibraryOverwriteTarget({
      tenantId: output.tenantId,
      ownerBridgeId: output.ownerBridgeId,
      folderId,
      name
    })
    : null
  if (existing && existing.id !== output.id) {
    const merged = await prisma.$transaction(async (tx) => {
      await tx.libraryFileVersion.create({ data: toLibraryFileVersionCreateInput(existing) })
      await tx.libraryFile.delete({ where: { id: output.id } })
      return await tx.libraryFile.update({
        where: { id: existing.id },
        data: {
          name,
          folderId,
          storedPath: output.storedPath,
          sizeBytes: output.sizeBytes,
          kind: output.kind,
          thumbnailPath: output.thumbnailPath,
          uploadedAt: new Date(),
          currentVersionNumber: existing.currentVersionNumber + 1,
          snapshotKey: null,
          origin: 'slice',
          createdById: output.createdById,
          createdByName: output.createdByName,
          restoredFromVersionNumber: null
        },
        select: { id: true, name: true }
      })
    })
    return { id: merged.id, name: merged.name, replacedExisting: true }
  }

  const file = await prisma.libraryFile.update({
    where: { id: fileId },
    data: { hidden: false, folderId, name },
    select: { id: true, name: true }
  })
  return { id: file.id, name: file.name, replacedExisting: false }
}

/**
 * Discard a "slice without saving" output that the user never kept. Deletes the file
 * (bytes + versions + row) ONLY while it is still hidden — if it has since been saved
 * (un-hidden) or is otherwise visible, this is a no-op so we never delete kept files.
 * Returns whether a file was deleted.
 */
export async function discardHiddenSlicedOutput(fileId: string): Promise<boolean> {
  const row = await prisma.libraryFile.findUnique({
    where: { id: fileId },
    include: { versions: { select: { ownerBridgeId: true, storedPath: true } } }
  })
  if (!row?.ownerBridgeId || !row.hidden) return false
  await prisma.libraryFile.delete({ where: { id: row.id } })
  await deleteLibraryFileBytes(row).catch(() => undefined)
  await Promise.all(row.versions.map((version) => deleteLibraryFileBytes(version).catch(() => undefined)))
  return true
}
