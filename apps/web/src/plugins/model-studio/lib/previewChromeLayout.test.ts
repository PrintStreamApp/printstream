import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  previewChromeLayout,
  VIEWPORT_INSET_PX,
  VIEW_CUBE_FOOTPRINT_PX
} from './previewChromeLayout'
// Imported for the drift check only. `viewCube.ts` pulls in THREE, which is why the layout module
// restates these rather than importing them.
import { VIEW_CUBE_EDGE_INSET, VIEW_CUBE_SIZE } from './viewCube'

const base = {}

test('the full-screen toggle owns the viewport top-right corner', () => {
  const layout = previewChromeLayout(base)
  assert.equal(layout.fullScreenToggle.top, VIEWPORT_INSET_PX)
  assert.equal(layout.fullScreenToggle.right, VIEWPORT_INSET_PX)
})

test('the progress bar clears the controls stacked in the corner beside it', () => {
  const standard = previewChromeLayout(base)
  assert.equal(standard.sceneProgress.right, 52, 'clears the full-screen toggle')
})

test('the concrete insets are the ones the viewport was built around', () => {
  // Pins the numbers themselves, so deriving them from named constants cannot quietly
  // move a control that was positioned by measurement against the real rendered chrome.
  assert.deepEqual(previewChromeLayout(base), {
    fullScreenToggle: { top: 12, right: 12 },
    sceneProgress: { top: 12, left: 12, right: 52 },
    gcodeConflictAlert: { bottom: 108, left: 12, right: 12 }
  })
})

test('the mobile legend button sits beside full screen and progress clears both', () => {
  const layout = previewChromeLayout({ showLegendToggle: true })
  assert.equal(layout.sceneProgress.right, 92)
})

test('the view cube footprint restated here still matches the cube itself', () => {
  // `viewCube.ts` imports THREE, so this pure module restates its two constants instead of
  // importing them. That duplication is only safe if something fails when they drift.
  assert.equal(VIEW_CUBE_FOOTPRINT_PX, VIEW_CUBE_EDGE_INSET + VIEW_CUBE_SIZE)
})

test('the conflict warning sits ABOVE the view cube, not beside it', () => {
  // Its first version used a reserve measured against the old moves strip rather than the 92px
  // cube: the banner landed 24px inside the cube, and
  // the cube's z-index is `tooltip` against the banner's 1, so the cube covered the banner's
  // warning icon and swallowed clicks on it. Asserting `left >= inset + reserve` could not catch
  // that, because it just restated the code. This asserts against the cube's REAL extent.
  const alert = previewChromeLayout(base).gcodeConflictAlert
  // The cube occupies [0, VIEW_CUBE_FOOTPRINT_PX] measured from the bottom AND from the left.
  // The banner spans the full width, so it can only avoid the cube by starting above it.
  assert.ok(
    alert.bottom > VIEW_CUBE_FOOTPRINT_PX,
    `banner bottom ${alert.bottom} must clear the cube's ${VIEW_CUBE_FOOTPRINT_PX}px reach`
  )
  assert.equal(alert.right, VIEWPORT_INSET_PX)
})
