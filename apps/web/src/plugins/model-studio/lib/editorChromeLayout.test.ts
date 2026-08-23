import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildEditorGridLayout, choosePlateStripOrientation } from './editorChromeLayout'

const base = { sidebarSide: 'right' as const, sidebarWidth: 388, showPlates: true, showPanel: true }

test('everything showing keeps the established two-column, two-row layout', () => {
  assert.deepEqual(buildEditorGridLayout(base), {
    gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 388px' },
    gridTemplateRows: { xs: 'auto minmax(0, 1fr) auto', sm: 'auto minmax(0, 1fr)' },
    gridTemplateAreas: { xs: '"plates" "viewport" "panel"', sm: '"plates panel" "viewport panel"' }
  })
  const left = buildEditorGridLayout({ ...base, sidebarSide: 'left' })
  assert.equal(left.gridTemplateColumns.sm, '388px minmax(0, 1fr)')
  assert.equal(left.gridTemplateAreas.sm, '"panel plates" "panel viewport"')
})

test('hiding the sidebar gives the whole width to the viewport, on both sides', () => {
  for (const sidebarSide of ['left', 'right'] as const) {
    const layout = buildEditorGridLayout({ ...base, sidebarSide, showPanel: false })
    assert.equal(layout.gridTemplateColumns.sm, 'minmax(0, 1fr)', `${sidebarSide}: one column`)
    assert.equal(layout.gridTemplateAreas.sm, '"plates" "viewport"')
    // No stranded row where the panel used to be, that would leave a gap, not a hidden panel.
    assert.equal(layout.gridTemplateRows.xs, 'auto minmax(0, 1fr)')
    assert.equal(layout.gridTemplateAreas.xs, '"plates" "viewport"')
  }
})

test('viewport-only leaves exactly one area at every width', () => {
  const layout = buildEditorGridLayout({ ...base, showPlates: false, showPanel: false })
  assert.deepEqual(layout, {
    gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr)' },
    gridTemplateRows: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr)' },
    gridTemplateAreas: { xs: '"viewport"', sm: '"viewport"' }
  })
})

test('a hidden plate strip still lets the sidebar span the full height', () => {
  const right = buildEditorGridLayout({ ...base, showPlates: false })
  assert.equal(right.gridTemplateAreas.sm, '"viewport panel"')
  assert.equal(right.gridTemplateRows.sm, 'minmax(0, 1fr)')
  const left = buildEditorGridLayout({ ...base, showPlates: false, sidebarSide: 'left' })
  assert.equal(left.gridTemplateAreas.sm, '"panel viewport"')
})

test('a vertical strip becomes a column beside the viewport, away from the sidebar', () => {
  const right = buildEditorGridLayout({ ...base, stripOrientation: 'vertical' })
  assert.equal(right.gridTemplateAreas.sm, '"plates viewport panel"')
  assert.equal(right.gridTemplateColumns.sm, '116px minmax(0, 1fr) 388px')
  // One row: the rail spans the height rather than sitting above the viewport.
  assert.equal(right.gridTemplateRows.sm, 'minmax(0, 1fr)')

  const left = buildEditorGridLayout({ ...base, sidebarSide: 'left', stripOrientation: 'vertical' })
  assert.equal(left.gridTemplateAreas.sm, '"panel viewport plates"')
  assert.equal(left.gridTemplateColumns.sm, '388px minmax(0, 1fr) 116px')

  // Narrow widths keep stacking, a rail there would eat width the viewport needs.
  assert.equal(right.gridTemplateAreas.xs, '"plates" "viewport" "panel"')
})

test('a vertical strip with no sidebar still leaves exactly the rail and the viewport', () => {
  const layout = buildEditorGridLayout({ ...base, showPanel: false, stripOrientation: 'vertical' })
  assert.equal(layout.gridTemplateAreas.sm, '"plates viewport"')
  assert.equal(layout.gridTemplateColumns.sm, '116px minmax(0, 1fr)')
})

test('hidden plates ignore the orientation entirely', () => {
  const hidden = buildEditorGridLayout({ ...base, showPlates: false, stripOrientation: 'vertical' })
  assert.deepEqual(hidden, buildEditorGridLayout({ ...base, showPlates: false }))
})

test('the strip goes vertical exactly when it buys the viewport a better shape', () => {
  const sized = (bodyWidth: number, bodyHeight: number, sidebarWidth = 388) =>
    choosePlateStripOrientation({ bodyWidth, bodyHeight, sidebarWidth, gap: 8 })

  // A short, wide window: a horizontal band would letterbox the 3D area, so use the rail.
  assert.equal(sized(1920, 620), 'vertical')
  // A tall window: height is what there is most of, so spend it on the band.
  assert.equal(sized(1280, 1400), 'horizontal')
  // A typical desktop with the sidebar open is already near 4:3: leave it alone.
  assert.equal(sized(1500, 900), 'horizontal')
  // Hiding the sidebar hands that width to the viewport and overshoots, so spending some of it on
  // a rail now costs nothing and buys the height back.
  assert.equal(sized(1500, 900, 0), 'vertical')
  // Unmeasured or degenerate boxes fall back to the layout the editor has always had.
  assert.equal(sized(0, 0), 'horizontal')
  assert.equal(sized(420, 900), 'horizontal', 'no room for a rail beside the sidebar')
})
