/**
 * The two ways an engine filter could strand a workspace, and why it does not.
 *
 * Both failure modes end the same way: a slice dialog with no engine in it, on
 * a surface that offers no route back to the setting that caused it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterVisibleEngines } from './slicer-engine-visibility.js'

const targets = [
  { id: 'bambustudio-2-6-0-51', label: '2.6.0.51' },
  { id: 'bambustudio-2-7-1-62', label: '2.7.1.62' },
  { id: 'bambustudio-2-8-1-55', label: '2.8.1.55' }
]

test('no choice shows everything', () => {
  // A workspace that has never chosen must not be pinned to whatever the engine
  // set happened to be the day it was created.
  assert.deepEqual(filterVisibleEngines(targets, null).map((t) => t.id), targets.map((t) => t.id))
  assert.deepEqual(filterVisibleEngines(targets, []).map((t) => t.id), targets.map((t) => t.id))
})

test('a choice hides the rest', () => {
  const visible = filterVisibleEngines(targets, ['bambustudio-2-7-1-62'])
  assert.deepEqual(visible.map((t) => t.id), ['bambustudio-2-7-1-62'])
})

test('a choice that matches nothing falls back to everything', () => {
  // The engines a workspace chose can be REMOVED from the deployment later. A
  // strict filter would then hide every engine and leave that workspace unable
  // to slice, unable to see why, and unable to fix it from the slice dialog.
  const visible = filterVisibleEngines(targets, ['bambustudio-9-9-9-99'])
  assert.deepEqual(visible.map((t) => t.id), targets.map((t) => t.id))
})

test('an engine added after the choice stays hidden', () => {
  // The allow-list is the point: a deny list would silently adopt every engine
  // added later, which is the opposite of what a curated workspace asked for.
  const chosen = ['bambustudio-2-6-0-51']
  const withNewEngine = [...targets, { id: 'bambustudio-3-0-0-01', label: '3.0.0.01' }]
  assert.deepEqual(filterVisibleEngines(withNewEngine, chosen).map((t) => t.id), chosen)
})
