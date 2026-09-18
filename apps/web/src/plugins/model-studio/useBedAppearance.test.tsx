/** Slow asset loads must not display a previous machine or resurrect disposed geometry. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { BufferGeometry, Texture } from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useBedAppearance } = await import('./useBedAppearance')
afterEach(cleanup)
after(() => dom.window.close())

test('hides obsolete assets, ignores late completions, and disposes resources on unmount', async () => {
  type Appearance = { geometry: BufferGeometry; texture: Texture }
  const pending: Array<(value: Appearance) => void> = []
  const signals: AbortSignal[] = []
  const load = (_input: unknown, signal: AbortSignal) => {
    signals.push(signal)
    return new Promise<Appearance>((resolve) => pending.push(resolve))
  }
  const props = { enabled: true, printerModel: 'A1', slicerTargetId: 'a', machineProfileId: null }
  const view = renderHook((p: typeof props) => useBedAppearance(p, load), { initialProps: props })
  const first = { geometry: new BufferGeometry(), texture: new Texture() }
  let firstDisposed = 0
  first.geometry.addEventListener('dispose', () => { firstDisposed += 1 })
  await act(async () => pending[0]!(first))
  assert.equal(view.result.current.geometry, first.geometry)

  view.rerender({ ...props, printerModel: 'H2D' })
  assert.equal(view.result.current.geometry, null)
  assert.equal(view.result.current.texture, null)
  assert.equal(firstDisposed, 1)
  view.rerender(props)
  assert.equal(view.result.current.geometry, null, 'returning to A1 must not expose its disposed mesh')
  assert.equal(signals[1]!.aborted, true)

  const late = { geometry: new BufferGeometry(), texture: new Texture() }
  let lateDisposed = 0
  late.geometry.addEventListener('dispose', () => { lateDisposed += 1 })
  await act(async () => pending[1]!(late))
  assert.equal(view.result.current.geometry, null)
  assert.equal(lateDisposed, 1)

  const current = { geometry: new BufferGeometry(), texture: new Texture() }
  let disposed = 0
  current.geometry.addEventListener('dispose', () => { disposed += 1 })
  current.texture.addEventListener('dispose', () => { disposed += 1 })
  await act(async () => pending[2]!(current))
  assert.equal(view.result.current.geometry, current.geometry)
  view.unmount()
  assert.equal(disposed, 2)
})
