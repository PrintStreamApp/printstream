import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorPaintStroke, type PaintHit } from './editorPaintStroke.js'
import type { PaintToolType } from '../editorGeometry.js'

const meshA = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
const meshB = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())

function hit(mesh: THREE.Mesh, x: number): PaintHit {
  return {
    mesh,
    point: new THREE.Vector3(x, 0, 0),
    normal: new THREE.Vector3(0, 0, 1),
    faceIndex: 0
  }
}

test('a fast brush move samples the path and breaks its sweep on misses and mesh changes', () => {
  const applied: Array<{ x: number; previous: number | null; phase: string }> = []
  const stroke = createEditorPaintStroke({
    getTool: () => 'circle',
    getTargets: () => [meshA, meshB],
    hitAt: (x) => x >= 6 && x < 9 ? null : hit(x >= 9 ? meshB : meshA, x),
    apply: (pick, phase, previous) => applied.push({
      x: pick.point.x,
      previous: previous?.x ?? null,
      phase
    })
  })

  stroke.start(hit(meshA, 0), 0, 0)
  assert.equal(stroke.active, true)
  assert.equal(stroke.move(12, 0)?.mesh, meshB)
  assert.deepEqual(applied, [
    { x: 0, previous: null, phase: 'down' },
    { x: 3, previous: 0, phase: 'move' },
    { x: 9, previous: null, phase: 'move' },
    { x: 12, previous: 9, phase: 'move' }
  ])

  stroke.reset()
  assert.equal(stroke.active, false)
  stroke.start(hit(meshA, 0), 0, 0)
  stroke.move(3, 0)
  assert.equal(applied.at(-1)?.previous, 0)
})

test('the stroke reads the current tool and apply callback for each event', () => {
  let tool: PaintToolType = 'circle'
  let target: string[] = []
  let apply = (phase: string) => target.push(`old:${phase}`)
  const sampled: number[] = []
  const stroke = createEditorPaintStroke({
    getTool: () => tool,
    getTargets: () => [meshA],
    hitAt: (x) => {
      sampled.push(x)
      return hit(meshA, x)
    },
    apply: (_pick, phase) => apply(phase)
  })

  stroke.start(hit(meshA, 0), 0, 0)
  apply = (phase) => target.push(`new:${phase}`)
  tool = 'fill'
  stroke.move(12, 0)

  assert.deepEqual(sampled, [12])
  assert.deepEqual(target, ['old:down', 'new:move'])
  stroke.reset()
  target = []
  stroke.start(hit(meshA, 2), 2, 0)
  stroke.move(12, 0)
  assert.deepEqual(target, ['new:down', 'new:move'])
})
