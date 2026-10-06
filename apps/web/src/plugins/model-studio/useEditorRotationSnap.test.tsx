import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { TransformControls } from 'three-stdlib'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { ROTATE_SNAP_COARSE, ROTATE_SNAP_FINE, type GizmoMode } from './editorGeometry'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorRotationSnap } = await import('./useEditorRotationSnap')

afterEach(cleanup)
after(() => dom.window.close())

test('Rotate alone snaps at 15 degrees and Shift temporarily selects 45 degrees', () => {
  const rotationSnaps: Array<number | null> = []
  const translationSnaps: Array<number | null> = []
  const scaleSnaps: Array<number | null> = []
  const transformRef = { current: {
    setRotationSnap: (snap: number | null) => rotationSnaps.push(snap),
    setTranslationSnap: (snap: number | null) => translationSnaps.push(snap),
    setScaleSnap: (snap: number | null) => scaleSnaps.push(snap)
  } as unknown as TransformControls }
  const { rerender } = renderHook(
    ({ mode }: { mode: GizmoMode }) => useEditorRotationSnap(mode, transformRef),
    { initialProps: { mode: 'select' as GizmoMode } }
  )

  assert.deepEqual(rotationSnaps, [null])
  rerender({ mode: 'rotate' })
  assert.deepEqual(rotationSnaps, [null, ROTATE_SNAP_FINE])
  window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Shift' }))
  window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Shift' }))
  assert.deepEqual(rotationSnaps, [null, ROTATE_SNAP_FINE, ROTATE_SNAP_COARSE, ROTATE_SNAP_FINE])

  rerender({ mode: 'select' })
  window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Shift' }))
  assert.equal(rotationSnaps.at(-1), null)
  assert.deepEqual(translationSnaps, [null, null, null])
  assert.deepEqual(scaleSnaps, [null, null, null])
})
