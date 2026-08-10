import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  OVERVIEW_VIEW_ROUTE_ID,
  isPrinterViewPath,
  printerViewPath,
  resolveActivePrinterViewId
} from './printerViewRoutes'

const views = [{ id: 'view-a' }, { id: 'view-b' }]

test('printerViewPath addresses a view under /printers/views', () => {
  assert.equal(printerViewPath('view-a'), '/printers/views/view-a')
  assert.equal(printerViewPath(OVERVIEW_VIEW_ROUTE_ID), '/printers/views/overview')
})

test('isPrinterViewPath recognises only view addresses', () => {
  assert.equal(isPrinterViewPath('/printers/views/view-a'), true)
  assert.equal(isPrinterViewPath('/printers'), false)
  assert.equal(isPrinterViewPath('/printers/some-printer-id'), false)
  assert.equal(isPrinterViewPath('/library'), false)
})

test('a pinned address wins over the stored default, even before the views load', () => {
  assert.equal(resolveActivePrinterViewId({
    routeViewId: 'view-b',
    storedDefaultViewId: 'view-a',
    views
  }), 'view-b')

  assert.equal(resolveActivePrinterViewId({
    routeViewId: 'view-b',
    storedDefaultViewId: null,
    views: []
  }), 'view-b')
})

test('the reserved overview segment pins the Overview past any stored default', () => {
  assert.equal(resolveActivePrinterViewId({
    routeViewId: OVERVIEW_VIEW_ROUTE_ID,
    storedDefaultViewId: 'view-a',
    views
  }), null)
})

test('the bare address applies the stored default only while it still exists', () => {
  assert.equal(resolveActivePrinterViewId({
    routeViewId: undefined,
    storedDefaultViewId: 'view-a',
    views
  }), 'view-a')

  // Stale stored id (view deleted) degrades to the Overview.
  assert.equal(resolveActivePrinterViewId({
    routeViewId: undefined,
    storedDefaultViewId: 'view-gone',
    views
  }), null)

  // Views not loaded yet: the default is not yet known to exist.
  assert.equal(resolveActivePrinterViewId({
    routeViewId: undefined,
    storedDefaultViewId: 'view-a',
    views: []
  }), null)

  assert.equal(resolveActivePrinterViewId({
    routeViewId: undefined,
    storedDefaultViewId: null,
    views
  }), null)
})
