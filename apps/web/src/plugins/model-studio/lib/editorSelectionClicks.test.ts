import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PartRef } from './selectionModel'
import { createEditorSelectionClicks } from './editorSelectionClicks'

const pointerAt = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent

test('empty clicks clear selection but orbit drags keep it', () => {
  const selected: Array<string | null> = []
  const clicks = createEditorSelectionClicks({
    selectExclusive: (key) => { selected.push(key) },
    selectBakedPart: () => undefined
  })

  clicks.beginEmpty(pointerAt(10, 20))
  clicks.finish(pointerAt(12, 22))
  clicks.beginEmpty(pointerAt(10, 20))
  clicks.finish(pointerAt(16, 20))
  assert.deepEqual(selected, [null])
})

test('a multi-selection click collapses it, but a body drag keeps it even if returned', () => {
  const selected: Array<string | null> = []
  const clicks = createEditorSelectionClicks({
    selectExclusive: (key) => { selected.push(key) },
    selectBakedPart: () => undefined
  })

  clicks.beginCollapse('part-a', pointerAt(10, 20))
  clicks.finish(pointerAt(12, 22))
  clicks.beginCollapse('part-b', pointerAt(10, 20))
  clicks.onBodyDragMove(pointerAt(16, 20))
  clicks.finish(pointerAt(10, 20))
  assert.deepEqual(selected, ['part-a'])
})

test('a still click drills into a baked part, while movement leaves object selection', () => {
  const picked: PartRef[] = []
  const clicks = createEditorSelectionClicks({
    selectExclusive: () => undefined,
    selectBakedPart: (part) => { picked.push(part) }
  })
  const part: PartRef = { objectId: 42, member: { kind: 'baked', partIndex: 2 } }

  clicks.beginBakedPart(part, pointerAt(30, 40))
  clicks.finish(pointerAt(34, 40))
  clicks.beginBakedPart(part, pointerAt(30, 40))
  clicks.finish(pointerAt(35, 40))
  assert.deepEqual(picked, [part])
})
