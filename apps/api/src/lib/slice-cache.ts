/**
 * Durable reuse of the most recent completed slice for each source project.
 *
 * A cache key covers the exact source bytes plus every input that can affect the engine output.
 * The cached artifact is an immutable library snapshot. A hit copies those bytes into a fresh
 * transient slice row so user actions never mutate or delete shared cache state.
 *
 * Cache-key compatibility is explicit. Bump {@link SLICE_CACHE_KEY_VERSION} whenever preparation
 * or post-processing semantics change without changing one of the hashed inputs.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  slicingMetadataSchema,
  type CreateSlicingJob,
  type PreservedSliceSettings,
  type SlicingMetadata,
  type SlicingTargetDescriptor
} from '@printstream/shared'
import { canonicalJson } from './canonical-json.js'
import { copyBridgeLibraryFile, deleteBridgeLibraryFile } from './bridge-library-files.js'
import { buildLibraryStoredPath } from './library-files.js'
import {
  ensureLibraryFileSnapshot,
  snapshotMutationKey,
  snapshotMutationMutex
} from './print-file-snapshots.js'
import { prisma } from './prisma.js'
import type { ResolvedSlicingPresetFile } from './slicing-presets.js'

// Version 3 includes artifact-derived per-plate print times in cached result metadata.
export const SLICE_CACHE_KEY_VERSION = 3

export interface SliceCacheLookupInput {
  /** Current request provenance, not the previous cache writer's tags. Excluded from byte identity. */
  sourceTagSnapshotJson?: string | null
  workspaceId: string
  sourceFileId: string
  sourceFileName: string
  sourcePath: string
  targetBridgeId: string
  executionPrinterModel: string | null
  hasFilamentTrackSwitch: boolean
  request: CreateSlicingJob
  profileFiles: ResolvedSlicingPresetFile[]
  slicerTarget: SlicingTargetDescriptor
}

export interface SliceCacheHit {
  outputFileId: string
  outputFileName: string
  slicerName: string | null
  metadata: SlicingMetadata
}

export interface SliceCacheLookup {
  cacheKey: string
  hit: SliceCacheHit | null
}

/**
 * Build the deterministic identity and materialize a private copy when the latest slice matches.
 *
 * A storage miss or stale key is normal and returns `hit: null`. Storage failures throw so the
 * orchestrator can log them and fall back to a real slice without failing the user's request.
 */
export async function lookupSlicingResultCache(
  input: SliceCacheLookupInput,
  deps: {
    copyBridgeLibraryFile: typeof copyBridgeLibraryFile
    deleteBridgeLibraryFile: typeof deleteBridgeLibraryFile
  } = { copyBridgeLibraryFile, deleteBridgeLibraryFile }
): Promise<SliceCacheLookup> {
  const cacheKey = await buildSliceCacheKey(input)
  const entry = await prisma.sliceCacheEntry.findUnique({
    where: {
      workspaceId_sourceFileId: {
        workspaceId: input.workspaceId,
        sourceFileId: input.sourceFileId
      }
    },
    select: {
      id: true,
      cacheKey: true,
      outputFileName: true,
      slicerName: true,
      metadataJson: true,
      sliceSettingsJson: true,
      sourceProject: {
        select: {
          id: true,
          workspaceId: true,
          hidden: true,
          deletedAt: true,
          snapshotKey: true
        }
      },
      artifactFile: {
        select: {
          id: true,
          workspaceId: true,
          ownerBridgeId: true,
          storedPath: true,
          sizeBytes: true,
          kind: true,
          hidden: true,
          deletedAt: true,
          snapshotKey: true
        }
      }
    }
  })
  if (!entry || entry.cacheKey !== cacheKey) return { cacheKey, hit: null }

  const artifact = entry.artifactFile
  if (
    artifact.workspaceId !== input.workspaceId
    || artifact.ownerBridgeId !== input.targetBridgeId
    || !artifact.hidden
    || artifact.deletedAt
    || !artifact.snapshotKey
  ) {
    return { cacheKey, hit: null }
  }

  const sourceProject = entry.sourceProject
  const sourceProjectFileId = sourceProject
    && sourceProject.workspaceId === input.workspaceId
    && sourceProject.hidden
    && !sourceProject.deletedAt
    && sourceProject.snapshotKey
    ? sourceProject.id
    : null
  const storedPath = buildLibraryStoredPath(entry.outputFileName)
  const output = await snapshotMutationMutex.run(
    snapshotMutationKey(input.workspaceId, artifact.snapshotKey),
    async () => {
      // Snapshot cleanup uses this same lock. It may see the artifact become unreferenced when a
      // newer cache entry wins, but cannot delete its bytes while this hit is copying them.
      await deps.copyBridgeLibraryFile({
        ownerBridgeId: input.targetBridgeId,
        sourceStoredPath: artifact.storedPath,
        targetStoredPath: storedPath
      })

      try {
        return await prisma.libraryFile.create({
          data: {
            workspaceId: input.workspaceId,
            ownerBridgeId: input.targetBridgeId,
            name: entry.outputFileName,
            storedPath,
            sizeBytes: artifact.sizeBytes,
            kind: artifact.kind,
            folderId: null,
            hidden: true,
            origin: 'slice',
            sourceProjectFileId,
            sliceSettingsJson: entry.sliceSettingsJson,
            sourceTagSnapshotJson: input.sourceTagSnapshotJson ?? null
          },
          select: { id: true, name: true }
        })
      } catch (error) {
        await deps.deleteBridgeLibraryFile(input.targetBridgeId, storedPath).catch(() => undefined)
        throw error
      }
    }
  )

  // Recency drives retention. Best-effort after the output is durable: failing to refresh the
  // convenience entry must not discard a valid output that can already be printed or saved.
  await prisma.sliceCacheEntry.update({
    where: { id: entry.id },
    data: { updatedAt: new Date() }
  }).catch((error: unknown) => {
    console.warn('[slice-cache] could not refresh cache recency:', error instanceof Error ? error.message : error)
  })

  return {
    cacheKey,
    hit: {
      outputFileId: output.id,
      outputFileName: output.name,
      slicerName: entry.slicerName,
      metadata: parseCachedMetadata(entry.metadataJson)
    }
  }
}

/**
 * Snapshot a completed output and make it the source project's single reusable slice.
 *
 * Best-effort at the orchestration boundary: this function reports real failures, while callers
 * keep the already-completed slice successful and log that only the reuse convenience was lost.
 */
export async function storeSlicingResultCache(
  input: {
    workspaceId: string
    sourceFileId: string
    cacheKey: string
    outputFileId: string
    outputFileName: string
    sourceProjectFileId: string | null
    slicerName: string | null
    metadata: SlicingMetadata
    settings: PreservedSliceSettings
  },
  deps: { ensureLibraryFileSnapshot: typeof ensureLibraryFileSnapshot } = { ensureLibraryFileSnapshot }
): Promise<void> {
  const artifact = await deps.ensureLibraryFileSnapshot(input.outputFileId)
  if (artifact.workspaceId !== input.workspaceId) {
    throw new Error('Cached slice artifact belongs to a different workspace')
  }

  await prisma.sliceCacheEntry.upsert({
    where: {
      workspaceId_sourceFileId: {
        workspaceId: input.workspaceId,
        sourceFileId: input.sourceFileId
      }
    },
    create: {
      workspaceId: input.workspaceId,
      sourceFileId: input.sourceFileId,
      cacheKey: input.cacheKey,
      artifactFileId: artifact.id,
      sourceProjectFileId: input.sourceProjectFileId,
      outputFileName: input.outputFileName,
      slicerName: input.slicerName,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      sliceSettingsJson: JSON.stringify(input.settings)
    },
    update: {
      cacheKey: input.cacheKey,
      artifactFileId: artifact.id,
      sourceProjectFileId: input.sourceProjectFileId,
      outputFileName: input.outputFileName,
      slicerName: input.slicerName,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      sliceSettingsJson: JSON.stringify(input.settings),
      updatedAt: new Date()
    }
  })
}

/** Hash the complete, output-affecting slice identity without buffering the project archive. */
export async function buildSliceCacheKey(input: SliceCacheLookupInput): Promise<string> {
  const executionRequest: Record<string, unknown> = { ...input.request }
  for (const placementOnlyField of [
    'sourceFileId',
    'sourceVersionId',
    'preparedSource',
    'contentBase',
    'outputFolderId',
    'hiddenOutput',
    'ownerClientId'
  ]) {
    delete executionRequest[placementOnlyField]
  }

  const hash = createHash('sha256')
  hash.update(canonicalJson({
    version: SLICE_CACHE_KEY_VERSION,
    sourceFileName: input.sourceFileName,
    targetBridgeId: input.targetBridgeId,
    executionPrinterModel: input.executionPrinterModel,
    hasFilamentTrackSwitch: input.hasFilamentTrackSwitch,
    preparedSourceContractVersion: input.request.preparedSource?.contractVersion ?? null,
    slicerTarget: input.slicerTarget,
    executionRequest,
    profileFiles: input.profileFiles
  }))
  hash.update('\0')
  for await (const chunk of createReadStream(input.sourcePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** Invalid persisted metadata is a cache decoration miss, never a reason to discard valid G-code. */
function parseCachedMetadata(value: string | null): SlicingMetadata {
  if (!value) return undefined
  try {
    return slicingMetadataSchema.catch(undefined).parse(JSON.parse(value))
  } catch {
    return undefined
  }
}
