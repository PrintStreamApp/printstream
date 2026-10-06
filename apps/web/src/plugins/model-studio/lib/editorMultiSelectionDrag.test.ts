import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorMultiSelectionDrag } from './editorMultiSelectionDrag'

function member(x: number): THREE.Group {
  const group = new THREE.Group()
  group.position.set(x, 0, 0.5)
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()))
  return group
}

test('multi-selection rotation uses the press snapshot on every frame and reseats on release', () => {
  const first = member(0)
  const second = member(10)
  const members = new Map([['first', first], ['second', second]])
  const proxy = new THREE.Group()
  proxy.position.set(5, 0, 0)
  let baked = 0
  let written = 0
  const drag = createEditorMultiSelectionDrag({
    proxy,
    selectedKeys: () => ['first', 'second'],
    groupFor: (key) => members.get(key) ?? null,
    bakeExactMatrix: () => { baked += 1 },
    writeBack: () => { written += 1 }
  })

  drag.begin()
  assert.equal(baked, 2)
  assert.deepEqual(drag.pivot()?.toArray(), [5, 0, 0])
  proxy.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)
  drag.apply('rotate')
  assert.ok(Math.abs(first.position.x - 10) < 1e-9)
  assert.ok(Math.abs(second.position.x) < 1e-9)

  drag.apply('rotate')
  assert.ok(Math.abs(first.position.x - 10) < 1e-9)
  assert.ok(Math.abs(second.position.x) < 1e-9)
  drag.finish('rotate')
  assert.equal(drag.pivot(), null)
  assert.deepEqual(proxy.quaternion.toArray(), [0, 0, 0, 1])
  assert.deepEqual(proxy.scale.toArray(), [1, 1, 1])
  assert.equal(written, 6)
})

test('scale rests members during a drag and reset releases its snapshot', () => {
  const first = member(0)
  const second = member(10)
  const members = new Map([['first', first], ['second', second]])
  const proxy = new THREE.Group()
  proxy.position.set(5, 0, 0)
  const drag = createEditorMultiSelectionDrag({
    proxy,
    selectedKeys: () => ['first', 'second'],
    groupFor: (key) => members.get(key) ?? null,
    bakeExactMatrix: () => undefined,
    writeBack: () => undefined
  })

  drag.begin()
  proxy.scale.set(2, 2, 2)
  drag.apply('scale')
  assert.equal(first.position.x, -5)
  assert.equal(second.position.x, 15)
  assert.equal(first.position.z, 1)
  assert.equal(second.position.z, 1)

  drag.reset()
  assert.equal(drag.pivot(), null)
  assert.equal(drag.apply('scale'), null)
})
