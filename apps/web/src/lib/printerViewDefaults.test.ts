import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveEffectiveDefaultPrinterViewId } from './printerViewDefaults'
import { OVERVIEW_VIEW_ROUTE_ID } from './printerViewRoutes'

const views = [{ id: 'view-a' }, { id: 'view-b' }]

test('a device override wins over the workspace default', () => {
  assert.equal(resolveEffectiveDefaultPrinterViewId({
    override: 'view-b',
    sharedDefaultViewId: 'view-a',
    views
  }), 'view-b')
})

test('the overview sentinel pins Overview past a workspace default view', () => {
  assert.equal(resolveEffectiveDefaultPrinterViewId({
    override: OVERVIEW_VIEW_ROUTE_ID,
    sharedDefaultViewId: 'view-a',
    views
  }), null)
})

test('no override follows the workspace default', () => {
  assert.equal(resolveEffectiveDefaultPrinterViewId({
    override: null,
    sharedDefaultViewId: 'view-a',
    views
  }), 'view-a')

  assert.equal(resolveEffectiveDefaultPrinterViewId({
    override: null,
    sharedDefaultViewId: null,
    views
  }), null)
})

test('a stale override falls through to the shared tier, a stale shared id to Overview', () => {
  assert.equal(resolveEffectiveDefaultPrinterViewId({
    override: 'view-gone',
    sharedDefaultViewId: 'view-a',
    views
  }), 'view-a')

  assert.equal(resolveEffectiveDefaultPrinterViewId({
    override: null,
    sharedDefaultViewId: 'view-gone',
    views
  }), null)

  // Views not loaded yet: nothing can be confirmed, so Overview.
  assert.equal(resolveEffectiveDefaultPrinterViewId({
    override: 'view-a',
    sharedDefaultViewId: null,
    views: []
  }), null)
})
