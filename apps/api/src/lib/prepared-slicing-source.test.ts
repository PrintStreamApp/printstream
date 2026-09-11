import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { buildBuiltinSlicingPresetId, type CreateSlicingJob } from '@printstream/shared'
import { prisma, rootPrisma } from './prisma.js'
import { authorizePreparedSlicingConfiguration, preparedSlicingConfigurationDigest, resolvePreparedSlicingSource } from './prepared-slicing-source.js'

const originalFindFirst = prisma.preparedSlicingSource.findFirst
const originalSettingFindUnique = rootPrisma.setting.findUnique
afterEach(() => {
  prisma.preparedSlicingSource.findFirst = originalFindFirst
  rootPrisma.setting.findUnique = originalSettingFindUnique
})

test('prepared slicing digest is stable across object key order and changes with frozen config', () => {
  const first = preparedSlicingConfigurationDigest({
    contractVersion: 1,
    slicerTargetId: 'bambu-1',
    target: {
      mode: 'manualProfile',
      printerModel: 'P1S',
      printerProfileId: 'machine',
      processSettingOverrides: { z: 'last', a: 'first' }
    },
    printerModel: 'P1S'
  })
  const reordered = preparedSlicingConfigurationDigest({
    target: {
      processSettingOverrides: { a: 'first', z: 'last' },
      printerProfileId: 'machine',
      printerModel: 'P1S',
      mode: 'manualProfile'
    },
    slicerTargetId: 'bambu-1',
    contractVersion: 1,
    printerModel: 'P1S'
  })
  assert.equal(first, reordered)
  assert.notEqual(first, preparedSlicingConfigurationDigest({
    contractVersion: 1,
    slicerTargetId: 'bambu-2',
    target: {
      mode: 'manualProfile',
      printerModel: 'P1S',
      printerProfileId: 'machine',
      processSettingOverrides: { a: 'first', z: 'last' }
    },
    printerModel: 'P1S'
  }))
  assert.notEqual(first, preparedSlicingConfigurationDigest({
    contractVersion: 1,
    slicerTargetId: 'bambu-1',
    target: {
      mode: 'manualProfile',
      printerModel: 'P1S',
      printerProfileId: 'machine',
      processSettingOverrides: { a: 'changed', z: 'last' }
    },
    printerModel: 'P1S'
  }), 'a changed submitted target invalidates the proof')
})

test('a deleted non-project process preset cannot collapse into an unbound proof', async () => {
  rootPrisma.setting.findUnique = (async () => null) as typeof rootPrisma.setting.findUnique
  await assert.rejects(authorizePreparedSlicingConfiguration({
    workspaceId: 'workspace-1',
    contractVersion: 1,
    slicerTargetId: null,
    target: {
      mode: 'manualProfile',
      printerModel: 'P1S',
      printerProfileId: buildBuiltinSlicingPresetId('machine', 'P1S machine'),
      processProfileId: 'custom:deleted-process'
    }
  }), /Slicing profile not found/)
})

test('prepared provenance is checked against source lineage and every frozen target setting', async () => {
  let where: Record<string, unknown> | null = null
  prisma.preparedSlicingSource.findFirst = (async (args: { where: Record<string, unknown> }) => {
    where = args.where
    return null
  }) as unknown as typeof prisma.preparedSlicingSource.findFirst
  const request: CreateSlicingJob = {
    sourceFileId: 'source-1',
    contentBase: { fileId: 'configuration-base-1', versionId: 'version-opened' },
    preparedSource: { id: 'proof-1', contractVersion: 1 },
    slicerTargetId: 'bambu-1',
    target: {
      mode: 'manualProfile',
      printerModel: 'P1S',
      printerProfileId: 'machine-1',
      processSettingOverrides: { layer_height: '0.2' }
    },
    plate: 1
  }

  await assert.rejects(
    resolvePreparedSlicingSource({
      workspaceId: 'workspace-1',
      sourceFileId: request.sourceFileId,
      request,
      authorization: {
        contractVersion: 1,
        slicerTargetId: 'bambu-1',
        target: request.target,
        printerModel: 'P1S'
      }
    }),
    /does not match this source and slicing configuration/
  )
  assert.ok(where)
  const captured = where as Record<string, unknown>
  assert.equal(captured.id, 'proof-1')
  assert.equal(captured.sourceFileId, 'source-1')
  assert.equal(captured.configurationBaseFileId, 'configuration-base-1')
  assert.equal(captured.configurationBaseVersionId, 'version-opened')
  assert.equal(captured.contractVersion, 1)
  assert.ok((captured.expiresAt as { gt?: unknown }).gt instanceof Date)
  assert.match(String(captured.configurationDigest), /^[a-f0-9]{64}$/)
  assert.deepEqual(captured.libraryFile, {
    workspaceId: 'workspace-1',
    deletedAt: null,
    hidden: true,
    origin: 'snapshot',
    snapshotKey: { not: null }
  })
})
