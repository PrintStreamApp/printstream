import assert from 'node:assert/strict'
import test from 'node:test'
import type { SceneEdit } from '@printstream/shared'
import type { SliceFileSubmitInput } from './libraryViewHelpers'
import { browserSliceResultIdentity, canReuseBrowserSliceResult } from './browserSliceResultCache'

function sliceInput(overrides: Partial<SliceFileSubmitInput> = {}): SliceFileSubmitInput {
  return {
    slicerTargetId: 'stable',
    target: {
      mode: 'manualProfile',
      printerProfileId: 'printer',
      printerModel: 'H2D',
      processProfileId: 'process',
      filamentMappings: [{ projectFilamentId: 1, profileId: 'pla' }]
    },
    outputFileName: 'project.gcode.3mf',
    outputFolderId: 'folder-1',
    plate: 1,
    preparedSourceId: 'prepared-1',
    ...overrides
  }
}

test('a disposable prepared-source id does not invalidate the browser result', () => {
  const previous = browserSliceResultIdentity({ file: { id: 'project-1' }, ...sliceInput() })
  const current = browserSliceResultIdentity({
    file: { id: 'project-1' },
    ...sliceInput({ preparedSourceId: 'prepared-2' })
  })

  assert.equal(canReuseBrowserSliceResult(previous, current), true)
})

test('a changed slice input invalidates the browser result', () => {
  const previous = browserSliceResultIdentity({ file: { id: 'project-1' }, ...sliceInput() })
  const changedProcess = browserSliceResultIdentity({
    file: { id: 'project-1' },
    ...sliceInput({
      target: {
        ...sliceInput().target,
        processProfileId: 'different-process'
      }
    })
  })
  const changedScene = browserSliceResultIdentity({
    file: { id: 'project-1' },
    ...sliceInput({
      sceneEdit: { plates: [{ index: 1, name: 'Changed', objects: [] }] } as unknown as SceneEdit
    })
  })

  assert.equal(canReuseBrowserSliceResult(previous, changedProcess), false)
  assert.equal(canReuseBrowserSliceResult(previous, changedScene), false)
})

test('source version and output placement are part of the open-dialog identity', () => {
  const previous = browserSliceResultIdentity({
    file: { id: 'project-1' },
    versionId: 'version-1',
    ...sliceInput()
  })
  const changedVersion = browserSliceResultIdentity({
    file: { id: 'project-1' },
    versionId: 'version-2',
    ...sliceInput()
  })
  const changedDestination = browserSliceResultIdentity({
    file: { id: 'project-1' },
    versionId: 'version-1',
    ...sliceInput({ outputFolderId: 'folder-2' })
  })

  assert.equal(canReuseBrowserSliceResult(previous, changedVersion), false)
  assert.equal(canReuseBrowserSliceResult(previous, changedDestination), false)
})
