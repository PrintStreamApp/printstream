import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PartRef, PartSelection } from './selectionModel'
import { performEditorDeleteShortcut } from './editorDeleteShortcut'

const bulk: PartSelection = {
  objectId: 7,
  members: [{ kind: 'baked', partIndex: 2 }, { kind: 'added', key: 'volume' }]
}
const single: PartRef = { objectId: 7, member: { kind: 'baked', partIndex: 2 } }

function deletePress(options: {
  mode?: 'measure' | 'translate'
  measurePickCount?: number
  bulkSelection?: PartSelection | null
  selectedPart?: PartRef | null
  removable?: boolean
  key?: string | null
}) {
  const events: string[] = []
  performEditorDeleteShortcut({
    key: options.key === undefined ? 'object' : options.key,
    mode: options.mode ?? 'translate',
    measurePickCount: options.measurePickCount ?? 0,
    clearMeasurement: () => { events.push('measurement') },
    bulkSelection: options.bulkSelection ?? null,
    selectedPart: options.selectedPart ?? null,
    partSelectionRemovable: (objectId, members) => {
      events.push(`guard:${objectId}:${members.length}`)
      return options.removable ?? true
    },
    removeParts: (objectId, members) => { events.push(`parts:${objectId}:${members.length}`) },
    clearBulkSelection: () => { events.push('clear bulk') },
    clearSelectedPart: () => { events.push('clear part') },
    deleteObject: (key) => { events.push(`object:${key}`) }
  })
  return events
}

test('Delete clears a live measurement before touching the selected object or part', () => {
  assert.deepEqual(deletePress({ mode: 'measure', measurePickCount: 2, selectedPart: single }), ['measurement'])
  assert.deepEqual(deletePress({ mode: 'measure', measurePickCount: 0, selectedPart: single }),
    ['guard:7:1', 'parts:7:1'])
})

test('Delete honours bulk parts, a single part, and the printable-geometry guard', () => {
  assert.deepEqual(deletePress({ bulkSelection: bulk, selectedPart: single }), ['guard:7:2', 'parts:7:2'])
  assert.deepEqual(deletePress({ bulkSelection: bulk, removable: false }), ['guard:7:2', 'clear bulk'])
  assert.deepEqual(deletePress({ selectedPart: single, removable: false }), ['guard:7:1', 'clear part'])
})

test('Delete reaches the object only with no part selection', () => {
  assert.deepEqual(deletePress({}), ['object:object'])
  assert.deepEqual(deletePress({ key: null }), [])
})
