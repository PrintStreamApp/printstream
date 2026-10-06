import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { PrinterView } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { OVERVIEW_VIEW_OPTION_VALUE } from '../lib/printerViewConstants'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { usePrinterViewRoute } = await import('./usePrinterViewRoute')

afterEach(cleanup)
after(() => dom.window.close())

const views = [{ id: 'view-1', name: 'Workshop' }] as PrinterView[]

test('a pinned view survives loading, then a deleted address and device default are repaired', () => {
  const events: string[] = []
  let viewsLoaded = false
  let routeViewId = 'deleted-view'
  let defaultViewOverride: string | null = 'deleted-default'
  const { result, rerender } = renderHook(() => usePrinterViewRoute({
    views: viewsLoaded ? views : [],
    viewsLoaded,
    routeViewId,
    defaultViewOverride,
    setDefaultViewOverride: (value) => { events.push(`override:${value}`); defaultViewOverride = value },
    sharedDefaultViewId: 'view-1',
    workspacePath: (path) => `/workspaces/test${path}`,
    navigate: (path, options) => events.push(`navigate:${path}:${options?.replace ?? false}`)
  }))

  assert.equal(result.current.activeViewId, 'deleted-view')
  assert.equal(result.current.activeView?.id ?? null, null)
  assert.equal(events.length, 0)

  viewsLoaded = true
  rerender()
  assert.equal(result.current.effectiveDefaultViewId, 'view-1')
  assert.deepEqual(events, [
    'override:null',
    'navigate:/workspaces/test/printers:true'
  ])

  routeViewId = 'view-1'
  rerender()
  assert.equal(result.current.activeView?.name, 'Workshop')
  assert.equal(events.length, 2)
})

test('view selection clears the draft before navigation and ignores transient null', () => {
  const events: string[] = []
  const { result } = renderHook(() => usePrinterViewRoute({
    views,
    viewsLoaded: true,
    routeViewId: 'overview',
    defaultViewOverride: 'overview',
    setDefaultViewOverride: () => events.push('override'),
    sharedDefaultViewId: 'view-1',
    workspacePath: (path) => `/workspaces/test${path}`,
    navigate: (path) => events.push(`navigate:${path}`)
  }))

  assert.equal(result.current.activeViewId, null)
  assert.equal(result.current.effectiveDefaultViewId, null)
  act(() => result.current.navigateToSelectedView(null, () => events.push('clear')))
  assert.equal(events.length, 0)

  act(() => result.current.navigateToSelectedView('view-1', () => events.push('clear')))
  act(() => result.current.navigateToSelectedView(OVERVIEW_VIEW_OPTION_VALUE, () => events.push('clear')))
  assert.deepEqual(events, [
    'clear', 'navigate:/workspaces/test/printers/views/view-1',
    'clear', 'navigate:/workspaces/test/printers/views/overview'
  ])
})
