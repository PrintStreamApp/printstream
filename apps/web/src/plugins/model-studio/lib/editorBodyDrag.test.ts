import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorBodyDrag } from './editorBodyDrag'

test('a click without movement creates no history entry', () => {
  const group = new THREE.Group()
  group.position.set(10, 12, 0)
  let history = 0
  const drag = createEditorBodyDrag({
    getSelectedKeys: () => ['one'],
    groupFor: () => group,
    bakeExactMatrix: () => undefined,
    recordHistory: () => { history += 1 },
    writeBackGroupTransform: () => undefined,
    reseatPivot: () => undefined,
    throttledPanelSync: () => undefined,
    markTranslationDrag: () => undefined
  })

  drag.begin(group, new THREE.Vector3(5, 7, 0))
  assert.equal(drag.active, true)
  assert.equal(drag.finish(), group)
  assert.equal(drag.active, false)
  assert.equal(history, 0)
  assert.deepEqual(group.position.toArray(), [10, 12, 0])
})

test('one press moves every selected object from its own offset and records history once', () => {
  const first = new THREE.Group()
  const second = new THREE.Group()
  first.position.set(10, 12, 0)
  second.position.set(20, 22, 0)
  const groups = new Map([['one', first], ['two', second]])
  const baked: THREE.Group[] = []
  const written: THREE.Group[] = []
  let history = 0
  let reseated = 0
  let synced = 0
  let markedTranslation = 0
  const drag = createEditorBodyDrag({
    getSelectedKeys: () => ['one', 'two'],
    groupFor: (key) => groups.get(key) ?? null,
    bakeExactMatrix: (group) => { baked.push(group) },
    recordHistory: () => { history += 1 },
    writeBackGroupTransform: (group) => { written.push(group) },
    reseatPivot: () => { reseated += 1 },
    throttledPanelSync: () => { synced += 1 },
    markTranslationDrag: () => { markedTranslation += 1 }
  })

  drag.begin(first, new THREE.Vector3(5, 7, 0))
  drag.beginCoDrag('one', new THREE.Vector3(5, 7, 0))
  assert.deepEqual(baked, [first, second])
  assert.equal(markedTranslation, 1)
  assert.equal(drag.move(new THREE.Vector3(7, 9, 0)), true)
  assert.equal(drag.move(new THREE.Vector3(8, 10, 0)), true)
  assert.deepEqual(first.position.toArray(), [13, 15, 0])
  assert.deepEqual(second.position.toArray(), [23, 25, 0])
  assert.equal(history, 1)
  assert.deepEqual(written, [first, second, first, second])
  assert.equal(reseated, 2)
  assert.equal(synced, 2)
  assert.equal(drag.finish(), first)
  assert.equal(drag.move(new THREE.Vector3(9, 11, 0)), false)
})
