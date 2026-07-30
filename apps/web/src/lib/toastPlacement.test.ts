import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MOBILE_TAB_BAR_CLEARANCE, TOAST_EDGE_GAP, resolveToastBottomGap } from './toastPlacement.js'

test('a phone toast clears the tab bar when nothing covers it', () => {
  assert.equal(resolveToastBottomGap({ dialogOpen: false }), MOBILE_TAB_BAR_CLEARANCE)
})

test('a dialog covers the tab bar, so the toast drops back to the viewport edge', () => {
  // Toasts sit above the modal layer, so keeping the lift leaves the toast hovering in empty space
  // over the dialog — the awkward gap this rule exists to remove.
  assert.equal(resolveToastBottomGap({ dialogOpen: true }), TOAST_EDGE_GAP)
})
