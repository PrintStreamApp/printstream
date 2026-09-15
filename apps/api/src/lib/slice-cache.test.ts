process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { CreateSlicingJob, PreservedSliceSettings, SlicingTargetDescriptor } from '@printstream/shared'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { prisma } from './prisma.js'
import {
  buildSliceCacheKey,
  lookupSlicingResultCache,
  storeSlicingResultCache,
  type SliceCacheLookupInput
} from './slice-cache.js'

const stub = usePrismaStubs()

test('slice cache keys ignore placement identity but cover every engine-affecting input', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-cache-key-'))
  try {
    const sourcePath = path.join(dir, 'project.3mf')
    await writeFile(sourcePath, Buffer.from('project bytes v1'))
    const base = makeLookupInput(sourcePath)
    const initial = await buildSliceCacheKey(base)

    assert.equal(await buildSliceCacheKey({
      ...base,
      sourceFileId: 'another-row-for-identical-bytes',
      request: {
        ...base.request,
        sourceFileId: 'another-row-for-identical-bytes',
        ownerClientId: 'another-tab',
        outputFolderId: 'another-folder',
        contentBase: { fileId: 'another-base', versionId: 'another-version' }
      }
    }), initial)

    assert.notEqual(await buildSliceCacheKey({
      ...base,
      slicerTarget: { ...base.slicerTarget, version: '2.0.0' }
    }), initial)
    assert.notEqual(await buildSliceCacheKey({
      ...base,
      hasFilamentTrackSwitch: true
    }), initial)
    assert.notEqual(await buildSliceCacheKey({
      ...base,
      profileFiles: [{ ...base.profileFiles[0]!, content: '{"layer_height":0.16}' }]
    }), initial)
    assert.notEqual(await buildSliceCacheKey({
      ...base,
      request: { ...base.request, plate: 2 }
    }), initial)

    await writeFile(sourcePath, Buffer.from('project bytes v2'))
    assert.notEqual(await buildSliceCacheKey(base), initial)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a cache hit copies the immutable artifact into a fresh disposable output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-cache-hit-'))
  try {
    const sourcePath = path.join(dir, 'project.3mf')
    await writeFile(sourcePath, Buffer.from('project bytes'))
    const input = makeLookupInput(sourcePath)
    const cacheKey = await buildSliceCacheKey(input)
    const copyCalls: Array<{ ownerBridgeId?: string | null; sourceStoredPath: string; targetStoredPath: string }> = []
    let createdData: Record<string, unknown> | null = null
    let refreshedId: string | null = null

    stub(prisma.sliceCacheEntry, 'findUnique', async () => ({
      id: 'cache-1',
      cacheKey,
      outputFileName: 'project.gcode.3mf',
      slicerName: 'Bambu Studio',
      metadataJson: JSON.stringify({ estimatedPrintTimeSeconds: 90 }),
      sliceSettingsJson: JSON.stringify(makePreservedSettings()),
      sourceProject: {
        id: 'preserved-project', workspaceId: 'workspace-1', hidden: true, deletedAt: null, snapshotKey: 'source-key'
      },
      artifactFile: {
        id: 'artifact-1',
        workspaceId: 'workspace-1',
        ownerBridgeId: 'bridge-1',
        storedPath: 'immutable.gcode.3mf',
        sizeBytes: 1_024,
        kind: 'gcode',
        hidden: true,
        deletedAt: null,
        snapshotKey: 'artifact-key'
      }
    }))
    stub(prisma.libraryFile, 'create', async (args: { data: Record<string, unknown> }) => {
      createdData = args.data
      return { id: 'fresh-output', name: String(args.data.name) }
    })
    stub(prisma.sliceCacheEntry, 'update', async (args: { where: { id: string } }) => {
      refreshedId = args.where.id
      return { id: args.where.id }
    })

    const result = await lookupSlicingResultCache(input, {
      copyBridgeLibraryFile: async (args) => { copyCalls.push(args) },
      deleteBridgeLibraryFile: async () => undefined
    })

    assert.equal(result.cacheKey, cacheKey)
    assert.deepEqual(result.hit, {
      outputFileId: 'fresh-output',
      outputFileName: 'project.gcode.3mf',
      slicerName: 'Bambu Studio',
      metadata: { estimatedPrintTimeSeconds: 90 }
    })
    assert.equal(copyCalls.length, 1)
    assert.equal(copyCalls[0]?.sourceStoredPath, 'immutable.gcode.3mf')
    assert.notEqual(copyCalls[0]?.targetStoredPath, 'immutable.gcode.3mf')
    const data = createdData as Record<string, unknown> | null
    assert.equal(data?.hidden, true)
    assert.equal(data?.origin, 'slice')
    assert.equal(data?.sourceProjectFileId, 'preserved-project')
    assert.equal(data?.sliceSettingsJson, JSON.stringify(makePreservedSettings()))
    assert.equal(refreshedId, 'cache-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('storing a cache entry snapshots the output and atomically replaces the source lineage', async () => {
  type UpsertArgs = { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }
  let upsertArgs: UpsertArgs | null = null
  stub(prisma.sliceCacheEntry, 'upsert', async (args: UpsertArgs) => {
    upsertArgs = args
    return { id: 'cache-1' }
  })

  await storeSlicingResultCache({
    workspaceId: 'workspace-1',
    sourceFileId: 'source-1',
    cacheKey: 'cache-key',
    outputFileId: 'output-1',
    outputFileName: 'project.gcode.3mf',
    sourceProjectFileId: 'preserved-project',
    slicerName: 'Bambu Studio',
    metadata: { estimatedPrintTimeSeconds: 90 },
    settings: makePreservedSettings()
  }, {
    ensureLibraryFileSnapshot: async () => ({
      id: 'artifact-1',
      workspaceId: 'workspace-1',
      ownerBridgeId: 'bridge-1',
      name: 'project.gcode.3mf',
      storedPath: 'immutable.gcode.3mf',
      sizeBytes: 1_024,
      kind: 'gcode',
      snapshotKey: 'artifact-key'
    })
  })

  const args = upsertArgs as unknown as UpsertArgs
  assert.deepEqual(args.where, {
    workspaceId_sourceFileId: { workspaceId: 'workspace-1', sourceFileId: 'source-1' }
  })
  assert.equal(args.create.artifactFileId, 'artifact-1')
  assert.equal(args.create.sourceProjectFileId, 'preserved-project')
  assert.equal(args.create.cacheKey, 'cache-key')
  assert.equal(args.update.artifactFileId, 'artifact-1')
})

function makeLookupInput(sourcePath: string): SliceCacheLookupInput {
  return {
    workspaceId: 'workspace-1',
    sourceFileId: 'source-1',
    sourceFileName: 'project.3mf',
    sourcePath,
    targetBridgeId: 'bridge-1',
    executionPrinterModel: 'X1C',
    hasFilamentTrackSwitch: false,
    request: makeRequest(),
    profileFiles: [{
      id: 'process-profile',
      source: 'custom',
      kind: 'process',
      name: 'Fine',
      content: '{"layer_height":0.12}'
    }],
    slicerTarget: makeTarget()
  }
}

function makeRequest(): CreateSlicingJob {
  return {
    sourceFileId: 'source-1',
    hiddenOutput: true,
    slicerTargetId: 'bambu-studio',
    target: {
      mode: 'manualProfile',
      printerProfileId: 'printer-profile',
      printerModel: 'X1C',
      processProfileId: 'process-profile',
      filamentMappings: []
    },
    plate: 1
  }
}

function makeTarget(): SlicingTargetDescriptor {
  return {
    id: 'bambu-studio',
    label: 'Bambu Studio',
    family: 'bambustudio',
    version: '1.0.0',
    slicerName: 'Bambu Studio',
    supportsEstimateModeMachineSwitch: false,
    isDefault: true,
    prerelease: false
  }
}

function makePreservedSettings(): PreservedSliceSettings {
  return {
    slicerTargetId: 'bambu-studio',
    target: makeRequest().target,
    plate: 1
  }
}
