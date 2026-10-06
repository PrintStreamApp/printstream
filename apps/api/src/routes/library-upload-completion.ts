/**
 * Completion policy for resumable library uploads.
 *
 * The receipt is recorded before file mutation for retry reconciliation. Snapshot staging and
 * versioned file writes share the transfer state but preserve their distinct persistence rules.
 * The route owns locking and passes its DTO and demo policy at the boundary.
 */
import { rm } from 'node:fs/promises'
import type { Request } from 'express'
import { z } from 'zod'
import { slicingTargetSchema } from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { authorizePreparedSlicingConfiguration, preparedSlicingConfigurationDigest, preparedSlicingSourceExpiry } from '../lib/prepared-slicing-source.js'
import { validatePreparedSlicingProject } from '../lib/prepared-slicing-validation.js'
import { prisma } from '../lib/prisma.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { ensureLibraryFolderPath, persistLibraryFileFromLocalPath } from '../lib/library-files.js'
import { ensureLibrarySnapshotFromLocalPath } from '../lib/print-file-snapshots.js'
import { visibleLibraryFilesWhere } from '../lib/library-visibility.js'
import { LIBRARY_UPLOAD_SESSION_RETENTION_MS, sessionPaths, writeUploadSession, type LibraryUploadCompletion, type LibraryUploadSession } from '../lib/library-upload-sessions.js'
import { requireRequestWorkspaceId } from '../lib/request-helpers.js'
import type { toDto } from './library-dto.js'

type LibraryDtoMapper = typeof toDto
type DemoLibraryMutationGuard = (request: Request, row: { hidden: boolean }) => void

/**
 * What the finished bytes BECOME. Sent with the completion step rather than the init step
 * because it decides persistence, not transfer: the chunking, resume, pacing and bridge
 * streaming above are identical for all three outcomes, and the editor is the one caller that
 * knows, at the moment it finishes baking, whether it is saving the project or only staging it.
 *
 * The two fields are independent, and `snapshot` is what changes the meaning of the other:
 * - neither: an ordinary upload, matched to an overwrite target by name (unchanged).
 * - `targetFileId` alone: a new version OF that file. Its name and folder win over the
 *   upload's, so the save cannot rename or move the project it is saving.
 * - `snapshot`: the bytes land as a hidden, content-deduped row and NOTHING else happens.
 *   `targetFileId` is then read-only: the snapshot borrows that file's bridge, because a
 *   browser has no bridge id of its own (`LibraryFile` deliberately carries none) and
 *   snapshots must be stored somewhere. For prepared slicing it is also the configuration
 *   base whose current or archived bytes the editor opened; `preparedSlicing.sourceFileId`
 *   independently preserves the project lineage used by slice placement and history.
 */
export const chunkUploadCompleteSchema = z.object({
  targetFileId: z.string().trim().min(1).optional(),
  snapshot: z.boolean().optional(),
  /** Freeze the browser-authored project to the exact target that will later queue it. */
  preparedSlicing: z.object({
    contractVersion: z.literal(1),
    /** Visible/hidden project row used for slice placement and history lineage. */
    sourceFileId: z.string().trim().min(1),
    slicerTargetId: z.string().trim().min(1).nullable().optional(),
    configurationBaseVersionId: z.string().trim().min(1).nullable().optional(),
    target: slicingTargetSchema
  }).optional()
}).superRefine((value, context) => {
  if (!value.preparedSlicing) return
  if (value.snapshot !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['snapshot'], message: 'Prepared slicing requires a snapshot upload' })
  }
  if (!value.targetFileId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['targetFileId'], message: 'Prepared slicing requires its configuration base file' })
  }
})


export type ChunkUploadCompletePayload = z.infer<typeof chunkUploadCompleteSchema>

export async function createLibraryFileFromUpload(input: {
  request: Request
  sourcePath: string
  fileName: string
  sizeBytes: number
  folderId: string | null
  bridgeId: string | null
  hidden: boolean
  /** Version this row rather than matching one by name (see `chunkUploadCompleteSchema`). */
  targetFileId?: string | null
  onBridgeProgress?: (transferredBytes: number) => Promise<void> | void
  onBridgeComplete?: () => Promise<void> | void
  completionReceiptId?: string | null
}) {
  const workspaceId = requireRequestWorkspaceId(input.request)
  return await persistLibraryFileFromLocalPath({
    workspaceId,
    sourcePath: input.sourcePath,
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    folderId: input.folderId,
    bridgeId: input.bridgeId,
    hidden: input.hidden,
    targetFileId: input.targetFileId ?? null,
    request: input.request,
    auditAction: 'upload',
    missingBridgeMessage: 'Select a bridge before uploading to the library',
    onBridgeProgress: input.onBridgeProgress,
    onBridgeComplete: input.onBridgeComplete,
    completionReceiptId: input.completionReceiptId ?? null
  })
}

/**
 * Perform one upload completion and persist its response before returning it.
 *
 * The route serializes this by upload id. A client whose bounded request times out can therefore
 * retry or poll: a retry waits for the original operation, then receives this exact stored result
 * instead of creating another file/version/snapshot.
 */
export async function completeLibraryUpload(input: {
  request: Request
  workspaceId: string
  session: LibraryUploadSession
  completionDigest: string
  payload: ChunkUploadCompletePayload
  toDto: LibraryDtoMapper
  assertDemoLibraryFileMutationAllowed: DemoLibraryMutationGuard
}): Promise<LibraryUploadCompletion> {
  const { request, workspaceId, session, completionDigest, payload, toDto, assertDemoLibraryFileMutationAllowed } = input
  const uploadId = session.id
  if (session.receivedBytes !== session.sizeBytes) {
    throw badRequest(`Upload is incomplete. Resume at byte ${session.receivedBytes}.`)
  }
  const targetFileId = payload.targetFileId ?? null
  const staging = payload.snapshot === true
  // Read once, for the bridge and for the demo guard. A missing row is a 404 here rather than
  // deeper in, so a stale editor tab hears "that file is gone" instead of silently getting a
  // second copy of the project (the whole reason the target is addressed by id).
  //
  // The two intents need different SCOPES. Versioning may only address a row the user can see, so
  // it keeps the visible filter. Staging only reads the row's bridge and never touches it, and the
  // row it is handed is routinely HIDDEN: an editor-born project's base is the new-project
  // scaffold, so the visible filter refused every slice of unsaved work in a new project. Hidden
  // rows stay reachable by id on purpose (see `library-visibility.ts`); a deleted one does not.
  const addressedFile = targetFileId
    ? await prisma.libraryFile.findFirst({
      where: staging
        ? { id: targetFileId, workspaceId, deletedAt: null }
        : visibleLibraryFilesWhere({ id: targetFileId, workspaceId }),
      select: { id: true, name: true, hidden: true, ownerBridgeId: true, storedPath: true }
    })
    : null
  if (targetFileId && !addressedFile) throw notFound('File not found')
  const sourceLineageFile = payload.preparedSlicing
    ? await prisma.libraryFile.findFirst({
      where: { id: payload.preparedSlicing.sourceFileId, workspaceId, deletedAt: null },
      select: { id: true }
    })
    : null
  if (payload.preparedSlicing && !sourceLineageFile) throw notFound('Source file not found')
  // Only the versioning path mutates the addressed file. Staging reads its bridge and leaves it
  // alone, so the demo's read-only curated library does not block a demo user from slicing.
  if (addressedFile && !staging) assertDemoLibraryFileMutationAllowed(request, addressedFile)

  // Reject destinations that cannot possibly store bytes before creating the durable receipt.
  // A receipt intentionally precedes the file mutation so retries cannot duplicate a completed
  // write, but recording one for an invalid request would leave the client reconciling work that
  // never started.
  const snapshotOwnerBridgeId = staging
    ? await resolveSnapshotOwnerBridgeId(session, addressedFile)
    : null
  if (!staging) await assertUploadDestinationAvailable(session, addressedFile)

  await prisma.libraryUploadCompletion.upsert({
    where: { id: uploadId },
    create: {
      id: uploadId,
      workspaceId,
      intentDigest: completionDigest,
      expiresAt: new Date(Date.now() + LIBRARY_UPLOAD_SESSION_RETENTION_MS)
    },
    update: {
      expiresAt: new Date(Date.now() + LIBRARY_UPLOAD_SESSION_RETENTION_MS)
    }
  })

  const { dataPath } = sessionPaths(uploadId)
  session.phase = 'transferring'
  session.bridgeReceivedBytes = 0
  session.completionDigest = completionDigest
  await writeUploadSession(session)
  const reportBridgeProgress = async (transferredBytes: number): Promise<void> => {
    session.bridgeReceivedBytes = transferredBytes
    await writeUploadSession(session)
  }

  let completion: LibraryUploadCompletion
  if (staging) {
    const staged = await stageLibraryUploadSnapshot({
      request,
      workspaceId,
      session,
      sourcePath: dataPath,
      addressedFile,
      sourceLineageFile,
      ownerBridgeId: snapshotOwnerBridgeId!,
      onBridgeProgress: reportBridgeProgress,
      preparedSlicing: payload.preparedSlicing ?? null
    })
    completion = {
      statusCode: 201,
      body: {
        file: { id: staged.id, name: staged.name },
        snapshot: true,
        preparedSourceId: staged.preparedSourceId
      }
    }
    await prisma.libraryUploadCompletion.update({
      where: { id: uploadId },
      data: {
        status: 'completed',
        libraryFileId: staged.id,
        fileName: staged.name,
        archivedVersionId: null,
        unchanged: false,
        snapshot: true,
        preparedSourceId: staged.preparedSourceId
      }
    })
  } else {
    // Folder-structure uploads: materialize the file's folder chain now (hidden
    // uploads never join a folder, so skip the tree there).
    const folderId = !session.hidden && session.relativeFolderPath?.length
      ? await ensureLibraryFolderPath({
        workspaceId,
        bridgeId: session.bridgeId,
        baseFolderId: session.folderId,
        segments: session.relativeFolderPath
      })
      : session.folderId
    const created = await createLibraryFileFromUpload({
      request,
      sourcePath: dataPath,
      fileName: session.fileName,
      sizeBytes: session.sizeBytes,
      folderId,
      bridgeId: session.bridgeId,
      hidden: session.hidden,
      targetFileId,
      onBridgeProgress: reportBridgeProgress,
      onBridgeComplete: async () => {
        session.phase = 'finalizing'
        session.bridgeReceivedBytes = session.sizeBytes
        await writeUploadSession(session)
      },
      completionReceiptId: uploadId
    })
    completion = {
      statusCode: 201,
      body: {
        // The version and its durable completion receipt are committed at this point. Do not keep
        // the editor blocked while the new 3MF is read back through the bridge for card metadata;
        // the cache-only path returns immediately and uses the listing's established background
        // warm-up when those derived chips are not already available.
        file: await toDto(created.file, { cacheOnly: true }),
        unchanged: created.unchanged,
        archivedVersionId: created.archivedVersionId
      }
    }
  }

  session.phase = 'completed'
  session.completion = completion
  session.completedAt = new Date().toISOString()
  await writeUploadSession(session)
  await rm(dataPath, { force: true })
  return completion
}

/** Rebuild the public completion response from the receipt committed with the mutation. */
export async function completionFromDurableReceipt(receipt: {
  libraryFileId: string | null
  fileName: string | null
  fileResultJson: string | null
  archivedVersionId: string | null
  unchanged: boolean | null
  snapshot: boolean
  preparedSourceId: string | null
}, toDto: LibraryDtoMapper): Promise<LibraryUploadCompletion> {
  if (!receipt.libraryFileId || !receipt.fileName) {
    throw new Error('Completed upload receipt is missing its file result')
  }
  if (receipt.snapshot) {
    return {
      statusCode: 201,
      body: {
        file: { id: receipt.libraryFileId, name: receipt.fileName },
        snapshot: true,
        preparedSourceId: receipt.preparedSourceId
      }
    }
  }
  const row = receipt.fileResultJson
    ? parseCompletionFileResult(receipt.fileResultJson)
    : await prisma.libraryFile.findFirst({ where: { id: receipt.libraryFileId } })
  if (!row) throw new Error('The file recorded by the completed upload no longer exists')
  return {
    statusCode: 201,
    body: {
      // The receipt may describe a row version that has since been superseded. Derive the original
      // response from its immutable snapshot, but never write those chips onto the live head.
      // Reconciliation exists to return the durable save result promptly. Library-card metadata
      // is derived in the background; reading the just-saved 3MF back through the bridge here can
      // take much longer than the save itself and would make a completed operation look stuck.
      file: await toDto(row, { cacheOnly: true, warmDerived: false }),
      unchanged: receipt.unchanged ?? false,
      archivedVersionId: receipt.archivedVersionId
    }
  }
}

/** Rehydrate the immutable row snapshot stored atomically with a completed file mutation. */
function parseCompletionFileResult(value: string): Parameters<LibraryDtoMapper>[0] & { deletedAt: Date | null } {
  const parsed = JSON.parse(value) as Parameters<LibraryDtoMapper>[0] & {
    uploadedAt: string | Date
    deletedAt?: string | Date | null
    lastPrintedAt?: string | Date | null
  }
  return {
    ...parsed,
    uploadedAt: new Date(parsed.uploadedAt),
    deletedAt: parsed.deletedAt ? new Date(parsed.deletedAt) : null,
    ...(parsed.lastPrintedAt ? { lastPrintedAt: new Date(parsed.lastPrintedAt) } : {})
  }
}

/**
 * Store a completed upload as a hidden, content-deduped snapshot instead of as a library file.
 *
 * What the editor needs to slice unsaved work: the bytes must be addressable by id, must not
 * become (or version) the user's project, and must not appear in any listing. That is exactly
 * a preserved-project snapshot, so this reuses it rather than inventing a second hidden kind:
 * identical bytes resolve to one row, and `pruneUnreferencedProjectSnapshots` reclaims a row
 * that no job or sliced output ever came to reference.
 */
async function stageLibraryUploadSnapshot(input: {
  request: Request
  workspaceId: string
  session: LibraryUploadSession
  sourcePath: string
  addressedFile: { id: string; name: string; ownerBridgeId: string | null; storedPath: string } | null
  sourceLineageFile: { id: string } | null
  ownerBridgeId: string
  onBridgeProgress: (transferredBytes: number) => Promise<void>
  preparedSlicing: ChunkUploadCompletePayload['preparedSlicing'] | null
}): Promise<{ id: string; name: string; preparedSourceId: string | null }> {
  if (input.preparedSlicing?.configurationBaseVersionId && input.addressedFile) {
    const version = await prisma.libraryFileVersion.findFirst({
      where: { id: input.preparedSlicing.configurationBaseVersionId, libraryFileId: input.addressedFile.id },
      select: { name: true, ownerBridgeId: true, storedPath: true }
    })
    if (!version) throw badRequest('The linked source project version no longer exists.')
  }
  const authorization = input.preparedSlicing
    ? await authorizePreparedSlicingConfiguration({
      workspaceId: input.workspaceId,
      ...input.preparedSlicing
    })
    : null
  if (input.preparedSlicing && authorization) {
    await validatePreparedSlicingProject({
      projectPath: input.sourcePath,
      target: input.preparedSlicing.target,
      printerModel: authorization.printerModel
    })
  }
  const snapshot = await ensureLibrarySnapshotFromLocalPath({
    workspaceId: input.workspaceId,
    ownerBridgeId: input.ownerBridgeId,
    fileName: input.session.fileName,
    sourcePath: input.sourcePath,
    sizeBytes: input.session.sizeBytes,
    onBridgeProgress: input.onBridgeProgress
  })
  const preparedConfigurationDigest = authorization
    ? preparedSlicingConfigurationDigest(authorization)
    : null
  const preparedSourceExpiresAt = preparedSlicingSourceExpiry()
  const preparedSource = input.preparedSlicing && input.addressedFile && input.sourceLineageFile && preparedConfigurationDigest
    ? await prisma.preparedSlicingSource.upsert({
      where: {
        workspaceId_libraryFileId_sourceFileId_configurationBaseFileId_configurationBaseVersionId_contractVersion_configurationDigest: {
          workspaceId: input.workspaceId,
          libraryFileId: snapshot.id,
          sourceFileId: input.sourceLineageFile.id,
          configurationBaseFileId: input.addressedFile.id,
          configurationBaseVersionId: input.preparedSlicing.configurationBaseVersionId ?? '',
          contractVersion: input.preparedSlicing.contractVersion,
          configurationDigest: preparedConfigurationDigest
        }
      },
      create: {
        workspaceId: input.workspaceId,
        libraryFileId: snapshot.id,
        sourceFileId: input.sourceLineageFile.id,
        configurationBaseFileId: input.addressedFile.id,
        configurationBaseVersionId: input.preparedSlicing.configurationBaseVersionId ?? '',
        contractVersion: input.preparedSlicing.contractVersion,
        configurationDigest: preparedConfigurationDigest,
        expiresAt: preparedSourceExpiresAt
      },
      // A content-dedup hit can return an old proof. Refresh its lease atomically with the upsert
      // so cleanup cannot reclaim the snapshot in the stage-to-enqueue gap.
      update: { expiresAt: preparedSourceExpiresAt },
      select: { id: true }
    })
    : null
  annotateRequestAuditLog(input.request, {
    action: 'stage-snapshot',
    resource: 'library file',
    summary: `Staged the hidden snapshot ${snapshot.name}.`,
    metadata: {
      fileId: snapshot.id,
      fileName: snapshot.name,
      sizeBytes: input.session.sizeBytes,
      // Lineage and configuration base are independent after Save As. Keep both so the audit
      // evidence says which project owns the slice and which current/archived bytes were edited.
      sourceFileId: input.sourceLineageFile?.id ?? input.addressedFile?.id ?? null,
      configurationBaseFileId: input.addressedFile?.id ?? null,
      preparedSourceId: preparedSource?.id ?? null,
      preparedSourceContractVersion: input.preparedSlicing?.contractVersion ?? null
    }
  })
  return { id: snapshot.id, name: snapshot.name, preparedSourceId: preparedSource?.id ?? null }
}

/**
 * Which bridge a staged snapshot's bytes go to. The addressed project comes first: a snapshot
 * of a project belongs on the bridge that holds the project, and it is the only hint a browser
 * always has (it knows the file it opened, never a bridge id).
 */
async function resolveSnapshotOwnerBridgeId(
  session: LibraryUploadSession,
  addressedFile: { ownerBridgeId?: string | null } | null
): Promise<string> {
  if (addressedFile?.ownerBridgeId) return addressedFile.ownerBridgeId
  if (session.bridgeId) return session.bridgeId
  if (session.folderId) {
    const folder = await prisma.libraryFolder.findUnique({
      where: { id: session.folderId },
      select: { ownerBridgeId: true }
    })
    if (folder?.ownerBridgeId) return folder.ownerBridgeId
  }
  // Library bytes are always bridge-owned, so there is no local fallback to stage into.
  throw badRequest('Select a bridge before staging a snapshot')
}

/**
 * Validate an ordinary upload's storage destination before its recovery receipt exists.
 * Persistence resolves the destination again at write time, where an addressed file's current
 * placement remains authoritative; this early pass exists solely to keep invalid requests out of
 * the reconciliation lifecycle.
 */
async function assertUploadDestinationAvailable(
  session: LibraryUploadSession,
  addressedFile: { ownerBridgeId?: string | null } | null
): Promise<void> {
  if (addressedFile?.ownerBridgeId) return
  if (session.folderId) {
    const folder = await prisma.libraryFolder.findUnique({
      where: { id: session.folderId },
      select: { ownerBridgeId: true }
    })
    if (!folder?.ownerBridgeId) throw notFound('Folder not found')
    return
  }
  if (session.bridgeId) return
  throw badRequest('Select a bridge before uploading to the library')
}
