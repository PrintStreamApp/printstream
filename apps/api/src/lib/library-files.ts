/**
 * Library file persistence helpers shared by uploads and generated artifacts.
 *
 * Bytes are stored through the bridge-backed library path, while metadata
 * and overwrite/version behavior stay centralized here.
 *
 * A write finds the row it versions in one of two ways, and they are not
 * interchangeable: an ordinary upload matches on (workspace, bridge, folder,
 * name), which is what makes re-uploading a file replace it, while a caller
 * that already knows the row (the editor saving the project it opened) passes
 * `targetFileId` and the row's own name/folder/bridge win over the upload's.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Request } from 'express'
import { classifyLibraryFileKind, type LibraryFile } from '@printstream/shared'
import { annotateRequestAuditLog } from './audit-logs.js'
import { badRequest, notFound } from './http-error.js'
import { prisma } from './prisma.js'
import { broadcastLibraryChanged } from './ws-resource-events.js'
import { deleteBridgeLibraryFile, deleteLibraryFileBytes, statBridgeLibraryFile, storeBridgeLibraryFile } from './bridge-library-files.js'
import { resolveRequestActorAttribution } from './actor-attribution.js'
import { visibleLibraryFilesWhere } from './library-visibility.js'
import { isUniqueConstraintError } from './prisma-errors.js'

type PersistedLibraryFileRow = Awaited<ReturnType<typeof prisma.libraryFile.create>>

type LibraryOverwriteTarget = {
  sourceTagSnapshotJson?: string | null
  id: string
  workspaceId: string
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

/**
 * DTO for a row that was just persisted, before its derived 3MF metadata exists.
 *
 * Non-route creators (plugins, background jobs) need to answer with a `LibraryFile`
 * but have no access to the listing's chip cache or the bridge parse behind it. The
 * chips are therefore reported as PENDING rather than empty: on the wire an empty
 * chip array without `metadataPending` asserts "derived: nothing there", which for a
 * file nothing has parsed is a lie the web latches decisions on (`geometryOnly`
 * routing). Marked pending only for the kinds that carry derived metadata, matching
 * `toDto` in the library routes.
 *
 * Self-healing: the row lands with no chip cache, so the next listing warms and
 * persists it and broadcasts a library change. Callers do not need to follow up.
 */
export function toCreatedLibraryFileDto(row: PersistedLibraryFileRow): LibraryFile {
  const carriesDerivedMetadata = row.kind === '3mf' || row.kind === 'gcode'
  return {
    id: row.id,
    name: row.name,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.uploadedAt.toISOString(),
    kind: row.kind as LibraryFile['kind'],
    thumbnailPath: row.thumbnailPath,
    folderId: row.folderId,
    compatiblePrinterModels: [],
    plateTypeChips: [],
    nozzleSizeChips: [],
    projectFilamentChips: [],
    plateCount: 0,
    ...(carriesDerivedMetadata ? { metadataPending: true } : {}),
    ...(row.currentVersionNumber ? { currentVersionNumber: row.currentVersionNumber } : {}),
    createdByName: row.createdByName ?? null,
    restoredFromVersionNumber: row.restoredFromVersionNumber ?? null,
    favorite: false,
    printCount: 0,
    lastPrintedAt: null
  }
}

export async function persistLibraryFileFromLocalPath(input: {
  workspaceId: string
  sourcePath: string
  fileName: string
  sizeBytes: number
  folderId: string | null
  bridgeId: string | null
  hidden: boolean
  /**
   * Version THIS row, instead of looking one up by (bridge, folder, name).
   *
   * The editor knows the id of the file it is saving a new version of, and name matching
   * cannot express that: a project renamed or moved since the session opened matches
   * nothing, so the save lands as a second file rather than as a version of the first. An
   * id that does not resolve to a visible file in `workspaceId` is a hard 404, never a
   * fall back to name matching, because falling back is precisely the silent duplicate.
   */
  targetFileId?: string | null
  request?: Request
  auditAction?: 'upload' | 'slice' | 'import'
  /** Frozen source-file tags for generated content; ordinary replacements clear provenance. */
  sourceTagSnapshotJson?: string | null
  /** Lifecycle origin override; defaults from `auditAction` ('slice' or 'upload'). */
  origin?: 'upload' | 'slice' | 'scaffold' | 'import'
  missingBridgeMessage?: string
  onBridgeProgress?: (transferredBytes: number) => Promise<void> | void
  onBridgeComplete?: () => Promise<void> | void
  /**
   * Chunked-upload receipt to complete in the same database transaction as the file mutation.
   * This closes the process-crash gap between committing a version and recording its outcome.
   */
  completionReceiptId?: string | null
}): Promise<{ file: PersistedLibraryFileRow; unchanged: boolean; archivedVersionId: string | null }> {
  const attribution = await resolveRequestActorAttribution(input.request)
  // Lifecycle origin drives cleanup windows (unsaved sliced outputs age out
  // faster than transient uploads).
  const origin = input.origin ?? (input.auditAction === 'slice' ? 'slice' : input.auditAction === 'import' ? 'import' : 'upload')
  const addressedTarget = input.targetFileId
    ? await findLibraryOverwriteTargetById({ workspaceId: input.workspaceId, fileId: input.targetFileId })
    : null
  if (input.targetFileId && !addressedTarget) throw notFound('File not found')

  // An addressed row decides its own placement, so its folder is not re-resolved: the caller's
  // folder/bridge describe where a NEW file would have landed, and honouring them here would
  // move the user's project as a side effect of saving it.
  const parentFolder = !addressedTarget && input.folderId
    ? await prisma.libraryFolder.findUnique({ where: { id: input.folderId }, select: { ownerBridgeId: true } })
    : null
  if (!addressedTarget && input.folderId && !parentFolder?.ownerBridgeId) {
    throw notFound('Folder not found')
  }
  // An overwrite never rewrites `ownerBridgeId`, so an addressed row's bytes MUST go to the
  // bridge that row already names; storing them anywhere else leaves the row pointing at a
  // path its own bridge does not have.
  const ownerBridgeId = addressedTarget ? addressedTarget.ownerBridgeId : (parentFolder?.ownerBridgeId ?? input.bridgeId)
  if (!ownerBridgeId) {
    throw badRequest(input.missingBridgeMessage ?? 'Select a bridge before saving to the library')
  }

  const overwriteTarget = addressedTarget ?? (!input.hidden
    ? await findLibraryOverwriteTarget({
      workspaceId: input.workspaceId,
      ownerBridgeId,
      folderId: input.folderId,
      name: input.fileName
    })
    : null)
  // A save is neither a rename nor a move, and the upload's copies of both can be stale (that
  // staleness is why the caller addressed the row by id at all), so the row keeps its name and
  // folder. `kind` follows the name it keeps.
  const targetName = addressedTarget?.name ?? input.fileName
  const targetFolderId = addressedTarget ? addressedTarget.folderId : input.folderId
  // Skip creating a redundant version when the upload is byte-identical to the
  // current file. We have the new bytes locally (`sourcePath`) before sending
  // them to the bridge, so hash here and compare against the current version's
  // hash on the bridge: identical content never gets stored or versioned. A
  // probe failure falls through to a normal upload rather than blocking it.
  if (overwriteTarget) {
    const unchangedFile = await resolveUnchangedOverwrite(ownerBridgeId, overwriteTarget, input.sourcePath)
    if (unchangedFile) {
      if (input.sourceTagSnapshotJson !== undefined) {
        await prisma.libraryFile.update({ where: { id: unchangedFile.id }, data: { sourceTagSnapshotJson: input.sourceTagSnapshotJson } })
      }
      if (input.completionReceiptId) {
        await prisma.libraryUploadCompletion.update({
          where: { id: input.completionReceiptId },
          data: {
            status: 'completed',
            libraryFileId: unchangedFile.id,
            fileName: unchangedFile.name,
            fileResultJson: JSON.stringify(unchangedFile),
            archivedVersionId: null,
            unchanged: true
          }
        })
      }
      return { file: unchangedFile, unchanged: true, archivedVersionId: null }
    }
  }

  const storedPath = buildLibraryStoredPath(targetName)
  await storeBridgeLibraryFile(ownerBridgeId, storedPath, input.sourcePath, { onProgress: input.onBridgeProgress })
  await input.onBridgeComplete?.()

  let created: PersistedLibraryFileRow
  // Id of the version row this write archived, i.e. the content that was current a moment ago.
  // Returned because the editor pins it as its content base: after its FIRST save, "the bytes we
  // opened" no longer live at the file's head, they live here. Without it the editor would have
  // to go hunting through version history to author its next save from the same original.
  let archivedVersionId: string | null = null
  const uploadedAt = new Date()
  try {
    if (overwriteTarget) {
      created = await prisma.$transaction(async (tx) => {
        const archived = await tx.libraryFileVersion.create({
          data: toLibraryFileVersionCreateInput(overwriteTarget)
        })
        archivedVersionId = archived.id
        const updated = await tx.libraryFile.update({
          where: { id: overwriteTarget.id },
          data: {
            name: targetName,
            storedPath,
            sizeBytes: input.sizeBytes,
            kind: classifyLibraryFileKind(targetName),
            folderId: targetFolderId,
            uploadedAt,
            currentVersionNumber: overwriteTarget.currentVersionNumber + 1,
            thumbnailPath: null,
            snapshotKey: null,
            createdById: attribution.createdById,
            createdByName: attribution.createdByName,
            // Fresh content replaces whatever the previous version's
            // provenance was, including the re-slice link, which described the
            // bytes being replaced. A slice re-sets it immediately afterwards
            // (see `preserveSlicedProject`); an upload correctly leaves it clear.
            sourceProjectFileId: null,
            sliceSettingsJson: null,
            sourceTagSnapshotJson: input.sourceTagSnapshotJson ?? null,
            restoredFromVersionNumber: null
          }
        })
        if (input.completionReceiptId) {
          await tx.libraryUploadCompletion.update({
            where: { id: input.completionReceiptId },
            data: {
              status: 'completed',
              libraryFileId: updated.id,
              fileName: updated.name,
              fileResultJson: JSON.stringify(updated),
              archivedVersionId: archived.id,
              unchanged: false
            }
          })
        }
        return updated
      })
    } else {
      const createData = {
        workspaceId: input.workspaceId,
        ownerBridgeId,
        name: input.fileName,
        storedPath,
        sizeBytes: input.sizeBytes,
        kind: classifyLibraryFileKind(input.fileName),
        folderId: input.hidden ? null : input.folderId,
        hidden: input.hidden,
        uploadedAt,
        origin,
        sourceTagSnapshotJson: input.sourceTagSnapshotJson ?? null,
        createdById: attribution.createdById,
        createdByName: attribution.createdByName
      }
      created = input.completionReceiptId
        ? await prisma.$transaction(async (tx) => {
            const inserted = await tx.libraryFile.create({ data: createData })
            await tx.libraryUploadCompletion.update({
              where: { id: input.completionReceiptId! },
              data: {
                status: 'completed',
                libraryFileId: inserted.id,
                fileName: inserted.name,
                fileResultJson: JSON.stringify(inserted),
                archivedVersionId: null,
                unchanged: false
              }
            })
            return inserted
          })
        : await prisma.libraryFile.create({ data: createData })
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
      summary: addressedTarget
        ? `Saved a new version of library file ${created.name}.`
        : overwriteTarget
          ? `Overwrote library file ${created.name}.`
          : action === 'slice'
            ? `Saved sliced library file ${created.name}.`
            : action === 'import'
              ? `Imported library file ${created.name} from a remote source.`
              : `Uploaded library file ${created.name}.`,
      metadata: {
        fileId: created.id,
        fileName: created.name,
        folderId: created.folderId,
        hidden: created.hidden,
        sizeBytes: created.sizeBytes,
        overwrittenVersionNumber: overwriteTarget?.currentVersionNumber ?? null,
        // Which row the write ADDRESSED. Without it the trail cannot tell an editor save
        // (targeted by id) from a same-named upload that happened to overwrite a file.
        targetFileId: input.targetFileId ?? null
      }
    })
  }
  if (!input.hidden) broadcastLibraryChanged()
  return { file: created, unchanged: false, archivedVersionId }
}

/**
 * Returns the unchanged current file row when an overwrite's bytes are identical
 * to what is already stored (so no new version is created), or null when the
 * content differs or the comparison could not be made (probe failure → upload
 * proceeds normally). Only applies to bridge-backed files.
 */
async function resolveUnchangedOverwrite(
  ownerBridgeId: string,
  overwriteTarget: LibraryOverwriteTarget,
  sourcePath: string
): Promise<PersistedLibraryFileRow | null> {
  try {
    const [newHash, existing] = await Promise.all([
      hashLocalFile(sourcePath),
      statBridgeLibraryFile({ ownerBridgeId, storedPath: overwriteTarget.storedPath })
    ])
    if (existing.contentSha256 !== newHash) return null
    return await prisma.libraryFile.findUniqueOrThrow({ where: { id: overwriteTarget.id } })
  } catch (error) {
    // Benign: a failed hash/stat probe just means we can't prove the upload is
    // identical, so it proceeds as a normal (new-version) upload. Log so a
    // persistent bridge stat failure is still visible.
    console.warn(`[library] identical-upload check failed for ${overwriteTarget.name}; proceeding with upload`, error instanceof Error ? error.message : error)
    return null
  }
}

/** SHA-256 (hex) of a local file's bytes, streamed so large files don't buffer. */
async function hashLocalFile(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Resolve, creating as needed, a chain of nested folders below `baseFolderId`
 * and return the deepest folder's id. Used by folder-structure uploads, where
 * the client sends each file's folder path relative to the upload destination.
 * Folders are metadata-only (file bytes stay flat on the bridge), so this only
 * touches `LibraryFolder` rows. A concurrent upload creating the same segment
 * loses the unique-constraint race and re-reads the winner's row.
 */
export async function ensureLibraryFolderPath(input: {
  workspaceId: string
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
    const where = { workspaceId: input.workspaceId, ownerBridgeId, parentId, name }
    let folder = await prisma.libraryFolder.findFirst({ where, select: { id: true } })
    if (!folder) {
      try {
        folder = await prisma.libraryFolder.create({ data: where, select: { id: true } })
        createdAny = true
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error
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
 * removed, and the contained files move to the recycle bin (soft delete,
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

/** Build a collision-resistant bridge path for a newly materialized library file. */
export function buildLibraryStoredPath(fileName: string): string {
  const safe = fileName.replace(/[^\w.-]+/g, '_')
  // A short random token disambiguates two uploads of the same name within the
  // same millisecond, without it they'd resolve to one storedPath and the two
  // concurrent writers would truncate/append over each other (and one's failure
  // cleanup would delete the other's bytes).
  return `${Date.now()}-${randomBytes(4).toString('hex')}-${safe}`
}

async function findLibraryOverwriteTarget(input: {
  workspaceId: string
  ownerBridgeId: string
  folderId: string | null
  name: string
}): Promise<LibraryOverwriteTarget | null> {
  return await prisma.libraryFile.findFirst({
    where: visibleLibraryFilesWhere({
      workspaceId: input.workspaceId,
      ownerBridgeId: input.ownerBridgeId,
      folderId: input.folderId,
      name: input.name
    }),
    orderBy: { uploadedAt: 'desc' }
  }) as LibraryOverwriteTarget | null
}

/**
 * Resolve an overwrite target the caller named by id, scoped to its workspace.
 *
 * Goes through {@link visibleLibraryFilesWhere} even though the lookup is by id: hidden rows
 * (snapshots, new-project scaffolds, unsaved sliced outputs) and recycled rows are not versions
 * of anything a user is editing, and quietly writing a new version over one would resurrect or
 * corrupt a row nothing shows. Returns null when no such row exists; the caller reports 404.
 */
async function findLibraryOverwriteTargetById(input: {
  workspaceId: string
  fileId: string
}): Promise<LibraryOverwriteTarget | null> {
  return await prisma.libraryFile.findFirst({
    where: visibleLibraryFilesWhere({ id: input.fileId, workspaceId: input.workspaceId })
  }) as LibraryOverwriteTarget | null
}

function toLibraryFileVersionCreateInput(row: LibraryOverwriteTarget) {
  return {
    sourceTagSnapshotJson: row.sourceTagSnapshotJson ?? null,
    workspaceId: row.workspaceId,
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
  // Append the sliced-output extension unless the caller supplied it in FULL.
  // Matching the whole compound `.gcode.3mf` (not a bare `.3mf`) keeps the final
  // name WYSIWYG with the save dialog's preview (apps/web
  // LibraryDestinationDialog, which shows `<name>.gcode.3mf` and predicts the
  // replace target from it): a typed `benchy.3mf` becomes `benchy.3mf.gcode.3mf`
  // exactly as previewed, instead of a name the dialog never showed.
  const trimmedName = options?.name?.trim()
  const name = trimmedName
    ? (trimmedName.toLowerCase().endsWith('.gcode.3mf') ? trimmedName : `${trimmedName}.gcode.3mf`)
    : output.name

  const existing = output.ownerBridgeId
    ? await findLibraryOverwriteTarget({
      workspaceId: output.workspaceId,
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
          // The surviving row now holds the OUTPUT's bytes, so it must hold the output's
          // re-slice provenance too: keeping the replaced file's would describe a project
          // that no longer produced this content. The output row is deleted just above, so
          // this is also what keeps its preserved project referenced.
          sourceProjectFileId: output.sourceProjectFileId,
          sliceSettingsJson: output.sliceSettingsJson,
          sourceTagSnapshotJson: output.sourceTagSnapshotJson,
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
 * (bytes + versions + row) ONLY while it is still hidden: if it has since been saved
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
  await discardUnreferencedProjectSnapshot(row.sourceProjectFileId)
  return true
}

/**
 * Drop the preserved project a discarded slice was the only reference to.
 *
 * A `snapshotKey` exempts a row from every AGE-based cleanup pass, so without this a discarded
 * "slice without saving" leaks its project bytes, one copy per discard, until the periodic backstop
 * (`pruneUnreferencedProjectSnapshots`) reclaims it on the same rule. Deliberately conservative:
 * it only deletes when NOTHING else points at the snapshot, because the same content-addressed row
 * is shared by every slice of identical bytes, and a print's history row references it too.
 *
 * Best-effort, a failure here leaks bytes, which must not fail the discard the user asked for.
 */
async function discardUnreferencedProjectSnapshot(projectFileId: string | null): Promise<void> {
  if (!projectFileId) return
  try {
    const [outputs, jobs, cacheEntries] = await Promise.all([
      prisma.libraryFile.count({ where: { sourceProjectFileId: projectFileId } }),
      prisma.printJob.count({ where: { sourceProjectFileId: projectFileId } }),
      prisma.sliceCacheEntry.count({ where: { sourceProjectFileId: projectFileId } })
    ])
    if (outputs > 0 || jobs > 0 || cacheEntries > 0) return
    const project = await prisma.libraryFile.findUnique({
      where: { id: projectFileId },
      select: { id: true, ownerBridgeId: true, storedPath: true, snapshotKey: true }
    })
    // Only ever a project SNAPSHOT: a null snapshotKey would mean a real library file got linked
    // here, and deleting the user's own project would be catastrophic.
    if (!project?.snapshotKey) return
    await prisma.libraryFile.delete({ where: { id: project.id } })
    await deleteLibraryFileBytes(project).catch(() => undefined)
  } catch (error) {
    console.warn('[library] failed to discard the preserved project snapshot', (error as Error).message)
  }
}
