import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { defaultPrinterCardContentSettings, defaultPrinterViewSort, type PrinterView, type PrinterViewInput } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/printers' })
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { usePrinterViewDraft } = await import('./usePrinterViewDraft')

afterEach(cleanup)
after(() => dom.window.close())

const defaults: PrinterViewInput = {
  name: 'Overview',
  cardsPerRow: 3,
  cardContentSettings: defaultPrinterCardContentSettings,
  sort: defaultPrinterViewSort,
  group: 'none',
  stateFilter: 'all',
  modelFilter: [],
  nozzleDiameterFilter: [],
  plateTypeFilter: [],
  printerIds: []
}

const savedView: PrinterView = {
  ...defaults,
  id: 'view-1',
  name: 'Workshop',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z'
}

test('saved-view edits stage, reset, and clear when the active view changes', () => {
  let activeViewId = 'view-1'
  const overviewEdits: unknown[] = []
  let pageResets = 0
  const { result, rerender } = renderHook(() => usePrinterViewDraft({
    activeView: savedView,
    activeViewId,
    overviewDefaults: defaults,
    onOverviewChange: (partial) => overviewEdits.push(partial),
    onStageChange: () => { pageResets += 1 }
  }))

  act(() => result.current.apply({ stateFilter: 'printing' }))
  assert.equal(result.current.content.stateFilter, 'printing')
  assert.equal(result.current.isDirty, true)
  assert.deepEqual(overviewEdits, [])
  assert.equal(pageResets, 1)

  act(() => result.current.clear())
  assert.equal(result.current.isDirty, false)

  act(() => result.current.apply({ stateFilter: 'printing' }))
  activeViewId = 'view-2'
  rerender()
  assert.equal(result.current.isDirty, false)
})

test('Overview edits write through instead of staging a saved-view draft', () => {
  const overviewEdits: unknown[] = []
  const { result } = renderHook(() => usePrinterViewDraft({
    activeView: null,
    activeViewId: null,
    overviewDefaults: defaults,
    onOverviewChange: (partial) => overviewEdits.push(partial),
    onStageChange: () => {}
  }))

  act(() => result.current.apply({ group: 'bridge' }))
  assert.deepEqual(overviewEdits, [{ group: 'bridge' }])
  assert.equal(result.current.isDirty, false)
})
