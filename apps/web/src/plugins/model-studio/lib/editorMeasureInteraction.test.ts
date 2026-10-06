import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorMeasureInteraction } from './editorMeasureInteraction'
import type { MeasurePick } from './editorMeasurePicking'

function pointer(x: number, y: number): PointerEvent {
  return { clientX: x, clientY: y } as PointerEvent
}

test('a measure click carries the resolved feature and source; orbit drags add nothing', () => {
  const feature = { kind: 'point' as const, point: new THREE.Vector3(1, 2, 3) }
  const source = { kind: 'point' as const, point: new THREE.Vector3(4, 5, 6) }
  const picked: MeasurePick = { feature, source }
  const added: MeasurePick[] = []
  let picks = 0
  const measure = createEditorMeasureInteraction({
    pick: () => { picks += 1; return picked },
    add: (value) => { added.push(value) },
    setHover: () => undefined,
    hasHover: () => false,
    clearHover: () => undefined
  })

  assert.equal(measure.finish(pointer(0, 0)), false)
  measure.begin(pointer(10, 10))
  assert.equal(measure.finish(pointer(13, 13)), true)
  assert.equal(picks, 1)
  assert.equal(added[0], picked)
  assert.equal(added[0]?.source, source)

  measure.begin(pointer(10, 10))
  assert.equal(measure.finish(pointer(15, 10)), true)
  assert.equal(picks, 1, 'five pixels is a camera drag, not a measurement click')
  measure.begin(pointer(10, 10))
  measure.reset()
  assert.equal(measure.finish(pointer(10, 10)), false)
})

test('a measure click with no feature is consumed without adding a point', () => {
  let added = false
  const measure = createEditorMeasureInteraction({
    pick: () => null,
    add: () => { added = true },
    setHover: () => undefined,
    hasHover: () => false,
    clearHover: () => undefined
  })
  measure.begin(pointer(0, 0))
  assert.equal(measure.finish(pointer(0, 0)), true)
  assert.equal(added, false)
})

test('measure hover uses the release picker and clears when its mode ends', () => {
  const point = { kind: 'point' as const, point: new THREE.Vector3(1, 2, 3) }
  const resolved: MeasurePick = { feature: point, source: point }
  let hovered: MeasurePick | null = null
  let pointMode = false
  const measure = createEditorMeasureInteraction({
    pick: () => resolved,
    add: () => undefined,
    setHover: (pick, shifted) => { hovered = pick; pointMode = shifted },
    hasHover: () => hovered !== null,
    clearHover: () => { hovered = null }
  })
  measure.updateHover({ ...pointer(0, 0), shiftKey: true }, true)
  assert.equal(hovered, resolved)
  assert.equal(pointMode, true)
  measure.updateHover(pointer(0, 0), false)
  assert.equal(hovered, null)
})
