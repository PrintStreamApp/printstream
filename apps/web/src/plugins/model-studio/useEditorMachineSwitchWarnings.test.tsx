import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { PlacementWarning } from './editorGeometry'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { toast } = await import('../../lib/toast')
const { useEditorMachineSwitchWarnings } = await import('./useEditorMachineSwitchWarnings')

afterEach(() => { cleanup(); toast.clear() })
after(() => dom.window.close())

test('machine-switch warnings wait for the new scene and fire once', () => {
  const snapshots: Array<Array<{ message: string; count: number }>> = []
  const unsubscribe = toast.subscribe((entries) => {
    snapshots.push(entries.map(({ message, count }) => ({ message, count })))
  })
  const offBed: PlacementWarning[] = [{ key: 'object-1', name: 'Object 1', issues: [], offBed: true }]
  const { rerender } = renderHook(
    ({ model, ready, warnings }: { model: string; ready: boolean; warnings: PlacementWarning[] }) =>
      useEditorMachineSwitchWarnings({
        targetPrinterModel: model,
        placementWarnings: warnings,
        sceneReady: ready,
        viewportBuilding: !ready,
        layerHeight: null,
        machineProfile: null
      }),
    { initialProps: { model: 'X1C', ready: true, warnings: offBed } }
  )
  assert.deepEqual(snapshots.at(-1), [])

  rerender({ model: 'A1', ready: false, warnings: [] })
  assert.deepEqual(snapshots.at(-1), [])
  rerender({ model: 'A1', ready: true, warnings: offBed })
  assert.match(snapshots.at(-1)?.[0]?.message ?? '', /no longer fits the A1 bed/)

  rerender({ model: 'A1', ready: true, warnings: [...offBed] })
  assert.equal(snapshots.at(-1)?.[0]?.count, 1)
  unsubscribe()
})
