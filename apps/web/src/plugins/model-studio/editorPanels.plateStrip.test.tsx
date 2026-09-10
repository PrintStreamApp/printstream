/**
 * Plate-strip entry points to a plate's options menu, and the tile-image sourcing rule.
 *
 * The kebab and a right-click on the tile must reach the SAME menu: the right-click was added
 * later, and the risk it carries is divergence (a second, thinner menu) or a right-click that
 * silently switches the active plate, which rebuilds the whole scene for what is only a rename.
 *
 * Tile images must resolve through the plate's IDENTITY (`plateId` for the live cache, the plate
 * object for the embedded fallback), never its live index: a reorder renumbers indices, and an
 * index-keyed lookup left the dragged plate's thumbnail on both its old and new positions.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { PlateThumbnailStrip } = await import('./editorPanels')
const { INHERITED_PLATE_SETTINGS } = await import('./lib/editorModel')

afterEach(() => cleanup())
after(() => dom.window.close())

type StripProps = Parameters<typeof PlateThumbnailStrip>[0]

function plate(index: number, identity: Partial<Pick<StripProps['plates'][number], 'plateId' | 'sourcePlateIndex'>> = {}): StripProps['plates'][number] {
  return {
    index,
    // Identity deliberately differs from the index so an index-keyed lookup cannot pass by luck.
    plateId: identity.plateId ?? index + 100,
    sourcePlateIndex: identity.sourcePlateIndex !== undefined ? identity.sourcePlateIndex : index,
    name: null,
    ...INHERITED_PLATE_SETTINGS,
    bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, maxZ: null, excludeAreas: [] },
    instances: [],
    primeTower: null
  }
}

/** The tile's thumbnail img src (or null while it shows the loading tile). */
function tileImageSrc(label: string): string | null {
  return screen.getByRole('button', { name: `Select ${label}` }).querySelector('img')?.getAttribute('src') ?? null
}

function renderStrip(overrides: Partial<StripProps> = {}) {
  const calls = {
    selected: [] as number[],
    renamed: [] as number[],
    removed: [] as number[],
    settingsFor: [] as number[]
  }
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
        onEditPlateSettings={(index) => calls.settingsFor.push(index)}
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

test('the options menu opens plate settings for the plate it was opened on', () => {
  const calls = renderStrip()

  fireEvent.contextMenu(screen.getByRole('button', { name: 'Select Plate 2' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Plate settings' }))

  assert.deepEqual(calls.settingsFor, [2], 'the settings action must act on the right-clicked plate')
})

test('a locked plate is marked on its tile', () => {
  // The lock is set inside a dialog, so without a mark on the tile the only evidence a plate is
  // locked is Auto-arrange quietly declining to move anything on it.
  const calls = renderStrip({ plates: [plate(1), { ...plate(2), locked: true }] })
  assert.deepEqual(calls.settingsFor, [])

  assert.ok(screen.getByRole('button', { name: 'Select Plate 2' }).querySelector('[data-testid="LockRoundedIcon"]'))
  assert.equal(screen.getByRole('button', { name: 'Select Plate 1' }).querySelector('[data-testid="LockRoundedIcon"]'), null)
})

test('a plate that overrides the project badges its kebab with the count', () => {
  // The engine applies a plate's own config OVER the project's, so the slice panel's plate-type
  // selector still shows the project's value while this plate prints on another. Without a mark
  // that selector reads as broken rather than as overridden. The badge sits on the KEBAB rather
  // than the label: it is the control that resolves the divergence, and it is always rendered.
  renderStrip({
    plates: [plate(1), { ...plate(2), plateTypeOverride: 'Engineering Plate', spiralMode: true }]
  })

  assert.ok(
    screen.getByRole('button', { name: 'Plate 2 options (2 overridden)' }),
    'the count must be reachable by name, not only as a coloured dot'
  )
  assert.ok(screen.getByRole('button', { name: 'Plate 1 options' }), 'an inheriting plate is unbadged')
})

test('a locked plate shows BOTH its lock and its override badge', () => {
  // The regression that motivated moving the signal: lock and override shared one decorator slot,
  // so a plate that was both showed only the lock and its overrides became invisible.
  renderStrip({ plates: [{ ...plate(1), locked: true, plateTypeOverride: 'Engineering Plate' }] })

  assert.ok(
    screen.getByRole('button', { name: 'Select Plate 1' }).querySelector('[data-testid="LockRoundedIcon"]'),
    'the lock keeps the label slot'
  )
  assert.ok(screen.getByRole('button', { name: 'Plate 1 options (1 overridden)' }), 'and the badge still counts')
})

test('the lock is not counted as an override', () => {
  // It refuses actions rather than changing what the plate prints, and has no project-level
  // counterpart to diverge from, so a merely-locked plate must not read as having overrides.
  renderStrip({ plates: [{ ...plate(1), locked: true }] })
  assert.ok(screen.getByRole('button', { name: 'Plate 1 options' }))
})

test('the plate settings menu item repeats the override count', () => {
  // The open menu covers the badge that raised the question, so the row it points at carries it.
  renderStrip({ plates: [plate(1), { ...plate(2), printSequence: 'by object' }] })
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Select Plate 2' }))

  const item = screen.getByRole('menuitem', { name: /Plate settings/ })
  assert.match(item.textContent ?? '', /1/, 'the item names how much is overridden')
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

test('live thumbnails follow the plate identity through a reorder, not its position', () => {
  // Plate 3 (plateId 103) was dragged to position 1: indices renumber 1..3 but each plateId,
  // and therefore each cached image, must travel with its plate. Keying the cache on the live
  // index is the bug where the moved plate's image showed on BOTH its old and new tiles.
  renderStrip({
    plates: [plate(1, { plateId: 103 }), plate(2, { plateId: 101 }), plate(3, { plateId: 102 })],
    thumbnails: {
      101: 'data:image/png;base64,AAA',
      102: 'data:image/png;base64,BBB',
      103: 'data:image/png;base64,CCC'
    }
  })
  assert.equal(tileImageSrc('Plate 1'), 'data:image/png;base64,CCC')
  assert.equal(tileImageSrc('Plate 2'), 'data:image/png;base64,AAA')
  assert.equal(tileImageSrc('Plate 3'), 'data:image/png;base64,BBB')
})

test('the embedded fallback is asked about the plate, and answers by source index', () => {
  // No live thumbnails: every tile falls back to the source archive's embedded PNG. After the
  // same 3 -> 1 reorder the tile at position 1 must fetch SOURCE plate 3's image, and a
  // session-added plate (no source) must show the loading tile rather than any position's PNG.
  renderStrip({
    plates: [
      plate(1, { plateId: 103, sourcePlateIndex: 3 }),
      plate(2, { plateId: 101, sourcePlateIndex: 1 }),
      plate(3, { plateId: 104, sourcePlateIndex: null })
    ],
    thumbnails: {},
    embeddedThumbnailUrl: (entry) => (entry.sourcePlateIndex === null ? null : `embedded:${entry.sourcePlateIndex}`)
  })
  assert.equal(tileImageSrc('Plate 1'), 'embedded:3')
  assert.equal(tileImageSrc('Plate 2'), 'embedded:1')
  assert.equal(tileImageSrc('Plate 3'), null, 'a session-added plate has no embedded image at any position')
})
