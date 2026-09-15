import assert from 'node:assert/strict'
import test from 'node:test'
import type { SceneEdit, SlicingTarget } from '@printstream/shared'
import {
  canReusePreparedSliceStage,
  preparedSliceStageIdentity,
  type PreparedSliceStageIdentity
} from './preparedSliceStageCache.js'

const sceneEdit: SceneEdit = {
  plates: [{ index: 1 }],
  instances: []
}

const target: SlicingTarget = {
  mode: 'manualProfile',
  printerProfileId: 'machine-1',
  printerModel: 'H2D',
  plateType: 'Cool Plate',
  nozzleDiameters: [0.4],
  toolheads: [{ id: '0', label: 'Single nozzle', nozzleDiameter: 0.4 }],
  processProfileId: 'process-1',
  filamentMappings: []
}

function identity(overrides: Partial<PreparedSliceStageIdentity> = {}): PreparedSliceStageIdentity {
  return {
    sceneEdit,
    sourceFileId: 'source-1',
    configurationBaseFileId: 'source-1',
    configurationBaseVersionId: 'version-1',
    objectProcessOverrides: undefined,
    target,
    slicerTargetId: 'bambustudio-2.8',
    ...overrides
  }
}

test('prepared slice stage ignores lifecycle callbacks but retains every byte-affecting input', () => {
  const first = preparedSliceStageIdentity({
    ...identity(),
    onPhase: () => undefined
  })
  const second = preparedSliceStageIdentity({
    ...identity(),
    onProgress: () => undefined
  })

  assert.equal(canReusePreparedSliceStage(first, second), true)
  assert.equal(canReusePreparedSliceStage(first, identity({ sceneEdit: { ...sceneEdit, plateType: 'Textured PEI Plate' } })), false)
  assert.equal(canReusePreparedSliceStage(first, identity({ target: { ...target, processProfileId: 'process-2' } })), false)
  assert.equal(canReusePreparedSliceStage(first, identity({ configurationBaseVersionId: 'version-2' })), false)
})
