import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearsDialogClose,
  previewChromeLayout,
  smallestInset,
  DIALOG_CLOSE_FOOTPRINT_PX,
  VIEWPORT_CONTROL_RESERVE_PX,
  VIEWPORT_INSET_PX,
  VIEWPORT_LAYER_COLUMN_RESERVE,
  VIEW_CUBE_FOOTPRINT_PX,
  type PreviewChromeInput
} from './previewChromeLayout'
// Imported for the drift check only. `viewCube.ts` pulls in THREE, which is why the layout module
// restates these rather than importing them.
import { VIEW_CUBE_EDGE_INSET, VIEW_CUBE_SIZE } from './viewCube'

const base: PreviewChromeInput = { fullScreen: false, showsGcodeLayerColumn: false, showsGcodeMovesStrip: false }

/** Every control this module places in the viewport's top-right corner. */
function topRightControls(input: PreviewChromeInput) {
  const layout = previewChromeLayout(input)
  return [
    { name: 'fullScreenToggle', ...layout.fullScreenToggle },
    { name: 'gcodeLayerColumn', ...layout.gcodeLayerColumn },
    { name: 'gcodeMovesStrip', ...layout.gcodeMovesStrip }
  ]
}

test('in full screen every top-right control clears the dialog close button', () => {
  // The regression this pins. Full screen drops the dialog's padding and header, so the close
  // button lands ON the viewport -- and it carries the higher z-index, so anything sharing that
  // corner is painted over and has its clicks taken. The layer column runs corner to corner and
  // was the one that landed under it.
  for (const layerColumn of [true, false]) {
    for (const movesStrip of [true, false]) {
      const input = { fullScreen: true, showsGcodeLayerColumn: layerColumn, showsGcodeMovesStrip: movesStrip }
      for (const control of topRightControls(input)) {
        assert.ok(
          clearsDialogClose(control),
          `${control.name} collides with the close button (layerColumn: ${layerColumn}, movesStrip: ${movesStrip})`
        )
      }
    }
  }
})

test('outside full screen the column keeps the whole edge, because the close button is not on it', () => {
  // The dialog's padding and title hold the viewport clear there, so yielding would shorten the
  // slider's travel for nothing -- which matters most on a phone.
  const layout = previewChromeLayout({ ...base, showsGcodeLayerColumn: true })
  assert.equal(layout.gcodeLayerColumn.top, VIEWPORT_INSET_PX)
  assert.equal(layout.gcodeLayerColumn.bottom, VIEWPORT_INSET_PX)
})

test('the scrubbers own their edges and the full-screen toggle yields to each one present', () => {
  const neither = previewChromeLayout(base)
  assert.equal(neither.fullScreenToggle.top, VIEWPORT_INSET_PX)
  assert.equal(neither.fullScreenToggle.right, VIEWPORT_INSET_PX)

  const movesOnly = previewChromeLayout({ ...base, showsGcodeMovesStrip: true })
  assert.equal(movesOnly.fullScreenToggle.top, VIEWPORT_INSET_PX + VIEWPORT_CONTROL_RESERVE_PX, 'drops below the moves strip')
  assert.equal(movesOnly.fullScreenToggle.right, VIEWPORT_INSET_PX)

  const layerOnly = previewChromeLayout({ ...base, showsGcodeLayerColumn: true })
  assert.equal(layerOnly.fullScreenToggle.top, VIEWPORT_INSET_PX)
  assert.deepEqual(layerOnly.fullScreenToggle.right, VIEWPORT_LAYER_COLUMN_RESERVE, 'steps left of the layer column')

  // Both present: the inner corner between them, not one or the other.
  const both = previewChromeLayout({ ...base, showsGcodeLayerColumn: true, showsGcodeMovesStrip: true })
  assert.equal(both.fullScreenToggle.top, VIEWPORT_INSET_PX + VIEWPORT_CONTROL_RESERVE_PX)
  assert.deepEqual(both.fullScreenToggle.right, VIEWPORT_LAYER_COLUMN_RESERVE)
})

test('the moves strip stops short of the layer column at every width', () => {
  const layout = previewChromeLayout({ ...base, showsGcodeLayerColumn: true, showsGcodeMovesStrip: true })
  const stripRight = smallestInset(layout.gcodeMovesStrip.right)
  // The column's own inset plus its measured width; overlapping by a few pixels is what
  // guessing from padding produced last time.
  assert.ok(stripRight > VIEWPORT_INSET_PX + 79, `strip stops at ${stripRight}, inside the column`)
})

test('the progress bar clears the controls stacked in the corner beside it', () => {
  const standard = previewChromeLayout(base)
  assert.ok(standard.sceneProgress.right >= DIALOG_CLOSE_FOOTPRINT_PX, 'clears the full-screen toggle')

  // Full screen puts a second control in that corner, so the bar has to stop earlier.
  const full = previewChromeLayout({ ...base, fullScreen: true })
  assert.ok(
    full.sceneProgress.right >= standard.sceneProgress.right + DIALOG_CLOSE_FOOTPRINT_PX,
    'clears the toggle AND the close button'
  )
})

test('clearsDialogClose reads a responsive inset at its narrowest', () => {
  // A control that only clears the button at `sm` still collides on a phone, so the check must
  // not average or take the wider value.
  assert.equal(smallestInset({ xs: 100, sm: 104 }), 100)
  assert.equal(clearsDialogClose({ top: VIEWPORT_INSET_PX, right: { xs: 20, sm: 200 } }), false)
  assert.equal(clearsDialogClose({ top: VIEWPORT_INSET_PX, right: VIEWPORT_LAYER_COLUMN_RESERVE }), true)
})

test('the concrete insets are the ones the viewport was built around', () => {
  // Pins the numbers themselves, so deriving them from named constants cannot quietly
  // move a control that was positioned by measurement against the real rendered chrome.
  assert.deepEqual(previewChromeLayout({ ...base, showsGcodeLayerColumn: true, showsGcodeMovesStrip: true }), {
    fullScreenToggle: { top: 76, right: { xs: 100, sm: 104 } },
    sceneProgress: { top: 12, left: 12, right: 52 },
    gcodeLayerColumn: { top: 12, right: 12, bottom: 12 },
    gcodeMovesStrip: { top: 12, left: 12, right: { xs: 100, sm: 104 } },
    gcodeConflictAlert: { bottom: 108, left: 12, right: { xs: 100, sm: 104 } }
  })
  assert.deepEqual(previewChromeLayout({ fullScreen: true, showsGcodeLayerColumn: false, showsGcodeMovesStrip: false }), {
    fullScreenToggle: { top: 12, right: 52 },
    sceneProgress: { top: 12, left: 12, right: 96 },
    gcodeLayerColumn: { top: 52, right: 12, bottom: 12 },
    gcodeMovesStrip: { top: 12, left: 12, right: { xs: 100, sm: 104 } },
    gcodeConflictAlert: { bottom: 108, left: 12, right: 12 }
  })
})

test('the view cube footprint restated here still matches the cube itself', () => {
  // `viewCube.ts` imports THREE, so this pure module restates its two constants instead of
  // importing them. That duplication is only safe if something fails when they drift.
  assert.equal(VIEW_CUBE_FOOTPRINT_PX, VIEW_CUBE_EDGE_INSET + VIEW_CUBE_SIZE)
})

test('the conflict warning sits ABOVE the view cube, not beside it', () => {
  // Its first version cleared the cube using VIEWPORT_CONTROL_RESERVE_PX, which was measured
  // against the 55px moves strip, not the 92px cube: the banner landed 24px inside the cube, and
  // the cube's z-index is `tooltip` against the banner's 1, so the cube covered the banner's
  // warning icon and swallowed clicks on it. Asserting `left >= inset + reserve` could not catch
  // that, because it just restated the code. This asserts against the cube's REAL extent.
  for (const showsGcodeLayerColumn of [true, false]) {
    const layout = previewChromeLayout({ ...base, showsGcodeLayerColumn, showsGcodeMovesStrip: false })
    const alert = layout.gcodeConflictAlert
    // The cube occupies [0, VIEW_CUBE_FOOTPRINT_PX] measured from the bottom AND from the left.
    // The banner spans the full width, so it can only avoid the cube by starting above it.
    assert.ok(
      alert.bottom > VIEW_CUBE_FOOTPRINT_PX,
      `banner bottom ${alert.bottom} must clear the cube's ${VIEW_CUBE_FOOTPRINT_PX}px reach`
    )
  }

  const withColumn = previewChromeLayout({ ...base, showsGcodeLayerColumn: true, showsGcodeMovesStrip: false })
  assert.deepEqual(withColumn.gcodeConflictAlert.right, VIEWPORT_LAYER_COLUMN_RESERVE, 'stops left of the layer column')
  const withoutColumn = previewChromeLayout({ ...base, showsGcodeLayerColumn: false, showsGcodeMovesStrip: false })
  assert.equal(withoutColumn.gcodeConflictAlert.right, VIEWPORT_INSET_PX, 'reclaims the edge when the column is gone')
})
