/**
 * Plate-strip entry points to a plate's options menu.
 *
 * The kebab and a right-click on the tile must reach the SAME menu — the right-click was added
 * later, and the risk it carries is divergence (a second, thinner menu) or a right-click that
 * silently switches the active plate, which rebuilds the whole scene for what is only a rename.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { PlateThumbnailStrip } = await import('./editorPanels')

afterEach(() => cleanup())
after(() => dom.window.close())

type StripProps = Parameters<typeof PlateThumbnailStrip>[0]

function plate(index: number): StripProps['plates'][number] {
  return {
    index,
    name: null,
    plateType: null,
    bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, excludeAreas: [] },
    instances: [],
    primeTower: null
  }
}

function renderStrip(overrides: Partial<StripProps> = {}) {
  const calls = { selected: [] as number[], renamed: [] as number[], removed: [] as number[] }
  render(
    <CssVarsProvider>
      <PlateThumbnailStrip
        plates={[plate(1), plate(2)]}
        activeIndex={1}
        thumbnails={{}}
        embeddedThumbnailUrl={() => null}
        onSelect={(index) => calls.selected.push(index)}
        onAddPlate={() => {}}
        onRemovePlate={(index) => calls.removed.push(index)}
        onRenamePlate={(index) => calls.renamed.push(index)}
        onReorderPlate={() => {}}
        {...overrides}
      />
    </CssVarsProvider>
  )
  return calls
}

test('right-clicking a plate opens that plate\'s options menu', () => {
  const calls = renderStrip()
  assert.equal(screen.queryByRole('menuitem', { name: 'Rename' }), null)

  fireEvent.contextMenu(screen.getByRole('button', { name: 'Select Plate 2' }))

  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
  assert.deepEqual(calls.renamed, [2], 'the menu must act on the right-clicked plate, not the active one')
})

test('right-clicking a plate does not switch to it', () => {
  // Selecting a plate rebuilds the scene. The kebab deliberately does not select, and neither
  // may the right-click that opens the same menu.
  const calls = renderStrip()
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Select Plate 2' }))
  assert.deepEqual(calls.selected, [])
})

test('the right-click menu offers the same actions as the kebab', () => {
  renderStrip()
  fireEvent.click(screen.getByRole('button', { name: 'Plate 2 options' }))
  const fromKebab = screen.getAllByRole('menuitem').map((item) => item.textContent)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  cleanup()

  renderStrip()
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Select Plate 2' }))
  const fromRightClick = screen.getAllByRole('menuitem').map((item) => item.textContent)

  assert.deepEqual(fromRightClick, fromKebab)
  assert.ok(fromKebab.length > 0, 'a strip with two plates offers Rename and Delete')
})

test('only the right-clicked plate opens a menu', () => {
  renderStrip()
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Select Plate 2' }))
  // One menu, not one per tile: the open state is held per strip, keyed by plate index.
  assert.equal(screen.getAllByRole('menu').length, 1)
})
