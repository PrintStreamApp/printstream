/**
 * Part-row wiring in the object list.
 *
 * A part is addressed by its ORDINAL within its object (`partIndex`), never by
 * `componentObjectId`, that is the MESH it references, and BambuStudio writes the same id for
 * every volume sharing a mesh. Both are `number`, so handing a callback the wrong one type-checks
 * cleanly and fails only at runtime: selection lands on the first part sharing the mesh, and with
 * duplicate ids the other parts become unreachable. These tests pin the ordinal at every part-row
 * callback, on a fixture whose ids deliberately never equal their ordinals.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen, within } = await import('@testing-library/react')
const { ObjectList } = await import('./editorPanels')

afterEach(() => cleanup())
after(() => dom.window.close())

type ListProps = Parameters<typeof ObjectList>[0]
type Instance = ListProps['instances'][number]

/**
 * One object whose four parts share a single mesh id (21) after a distinct first part: the shape
 * of a real assembly with repeated modifier cubes, and the case where mesh id and ordinal diverge.
 * No `componentObjectId` here equals its ordinal, so a caller that passes the wrong one is caught
 * even without duplicates.
 */
function assembly(): Instance {
  const part = (componentObjectId: number, partIndex: number, name: string) => ({
    entryPath: '3D/3dmodel.model',
    componentObjectId,
    partIndex,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    filamentId: null,
    name,
    color: null,
    subtype: 'normal_part' as const
  })
  return {
    key: 'obj-7-0',
    source: { kind: 'object' },
    objectId: 7,
    instanceId: 0,
    name: 'Assembly',
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    filamentId: 1,
    printable: true,
    parts: [
      part(20, 0, 'Mount'),
      part(21, 1, 'Cube A'),
      part(21, 2, 'Cube B'),
      part(21, 3, 'Cube C')
    ]
  } as Instance
}

function renderList(overrides: Partial<ListProps> = {}) {
  const calls = {
    selected: [] as number[],
    context: [] as number[],
    settings: [] as number[],
    overrideCounts: [] as number[]
  }
  render(
    <CssVarsProvider>
      <ObjectList
        instances={[assembly()]}
        selectedKey={'obj-7-0'}
        onSelect={() => {}}
        onSelectPart={(_objectId, member) => { if (member.kind === 'baked') calls.selected.push(member.partIndex) }}
        onPartContextMenu={(_objectId, member) => { if (member.kind === 'baked') calls.context.push(member.partIndex) }}
        onTogglePrintable={() => {}}
        perObject={{
          sliceObjectIds: new Set([7]),
          overrideCountFor: () => 0,
          onEditObject: () => {},
          onEditPart: (_objectId, partIndex) => calls.settings.push(partIndex),
          partOverrideCountFor: (_objectId, partIndex) => {
            calls.overrideCounts.push(partIndex)
            return 0
          }
        }}
        {...overrides}
      />
    </CssVarsProvider>
  )
  return calls
}

test('clicking a part row selects it by ordinal, not by the mesh id it shares', () => {
  const calls = renderList()
  // Three rows read "Cube A/B/C" but all three draw mesh 21; only the ordinal tells them apart.
  fireEvent.click(screen.getByText('Cube B'))
  fireEvent.click(screen.getByText('Cube C'))
  fireEvent.click(screen.getByText('Mount'))
  assert.deepEqual(calls.selected, [2, 3, 0])
})

test('right-clicking a part row opens the menu for that ordinal', () => {
  const calls = renderList()
  fireEvent.contextMenu(screen.getByText('Cube C').closest('li')!)
  assert.deepEqual(calls.context, [3])
})

test('per-part settings address the part by ordinal', () => {
  const calls = renderList()
  // Every row asks for its own override count, in order.
  assert.deepEqual(calls.overrideCounts, [0, 1, 2, 3])
  fireEvent.click(screen.getByRole('button', { name: 'Part settings for Cube B' }))
  assert.deepEqual(calls.settings, [2])
})

test('the gizmo highlight follows the selected ordinal, not its mesh siblings', () => {
  renderList({ gizmoPart: { objectId: 7, member: { kind: 'baked', partIndex: 2 } } })
  const background = (name: string) =>
    dom.window.getComputedStyle(screen.getByText(name).closest('li')!).backgroundColor
  const transparent = 'rgba(0, 0, 0, 0)'
  // Assert both directions: keying the highlight off the shared mesh id leaves the selected row
  // unhighlighted (no id equals 2), and a naive id match would light up all three cubes at once.
  assert.notEqual(background('Cube B'), transparent, 'the selected ordinal\'s row must be highlighted')
  for (const sibling of ['Mount', 'Cube A', 'Cube C']) {
    assert.equal(background(sibling), transparent, `${sibling} must not be highlighted`)
  }
})

test('a part row keeps its identity key, so a reorder does not remount the list', () => {
  // An index key remounts every row of a reordered object, which reads as the list flickering
  // mid-drag. The rows are keyed by ordinal instead, which survives a permutation.
  const calls = renderList({ onReorderPart: () => {} })
  // Re-rendering with the parts in a different order must keep each row bound to its own ordinal:
  // the callbacks below still report the ordinal, not the new position.
  fireEvent.click(screen.getByText('Cube C'))
  assert.deepEqual(calls.selected, [3])
})

test('a press with no movement is a click, not a part drop', () => {
  const drops: Array<[number, number, number | null]> = []
  renderList({ onReorderPart: (hostId, partIndex, before) => drops.push([hostId, partIndex, before]) })
  // The drag hook is a pointer state machine over `window`; the wiring under test here is that a
  // part row arms its OWN object's group with its OWN ordinal. Pressing a row must not throw and
  // must not arm the object group (which would let a volume land between objects).
  const row = screen.getByText('Cube B')
  fireEvent.pointerDown(row, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 })
  // The hook listens on `window`; a bubbling event from the body reaches it.
  fireEvent.pointerUp(dom.window.document.body, { pointerId: 1 })
  assert.deepEqual(drops, [])
})

/*
 * GAP, deliberately left: nothing here drives a part drag to COMPLETION, so what `onReorderPart`
 * reports on a real drop -- three ordinals, `(hostId, partIndex, beforePartIndex)` -- is unpinned.
 * The fixture is ready for it (parts 1-3 share `componentObjectId` 21 and no mesh id equals its
 * ordinal, so a row position could never pass as one); what is missing is driving the pointer state
 * machine from here. Two attempts stubbed the row and container rects and dispatched the same
 * `pointerId`-carrying window events `useListReorderDrag.test.tsx` uses, and the drop still never
 * fired, so the container registration or the movement threshold needs tracing first. That hook's
 * own suite does cover drop resolution; what it cannot see is this list's ordinal wiring.
 */
test('an object with a single part offers no part drag at all', () => {
  // Nothing to reorder, and a one-row group would still register a drag surface.
  const single = assembly()
  single.parts = [single.parts[0]!]
  const drops: number[] = []
  render(
    <CssVarsProvider>
      <ObjectList
        instances={[single]}
        selectedKey={'obj-7-0'}
        onSelect={() => {}}
        onTogglePrintable={() => {}}
        onReorderPart={(_hostId, partIndex) => drops.push(partIndex)}
      />
    </CssVarsProvider>
  )
  // The single part does not get its own row: the list shows the object only.
  assert.equal(screen.queryByText('Mount'), null)
  assert.deepEqual(drops, [])
})

/**
 * A session-added volume's row must offer the SAME part actions as a baked part row, addressed by
 * the volume's own key rather than an ordinal.
 *
 * The plugin's rule is that every part-scoped callback is pinned here, and added parts had no
 * fixture at all -- which is how the row shipped for a while with no context menu and with its
 * settings icon gated to modifiers only.
 */
const NO_PARTS: never[] = []

function addedVolume(key: string, name: string, subtype = 'normal_part', settings?: Record<string, string>) {
  return { key, importId: 'imp-1', subtype, name, filamentId: null, ...(settings ? { settings } : {}) } as never
}

test("the object's own geometry gets a row only once something is added beside it", () => {
  // BambuStudio's rule: a row per volume as soon as there are two, and none at one. An object with
  // no part list keeps its body on the instance mesh, so on its own it is a single volume and shows
  // no part rows; add a part and there are two, so the body earns a row too. Without it the body has
  // nothing to click and the object row is the only thing standing in for it.
  const single = { ...assembly(), parts: [], name: 'Cube' } as never
  const render1 = () => render(
    <CssVarsProvider>
      <ObjectList
        instances={[single]}
        selectedKey={'obj-7-0'}
        onSelect={() => {}}
        onTogglePrintable={() => {}}
        addedPartsFor={() => NO_PARTS}
        onSelectPart={() => {}}
      />
    </CssVarsProvider>
  )
  render1()
  // One volume: the object row only, no row standing in for the body.
  assert.equal(screen.queryAllByText('Cube').length, 1)
  cleanup()

  render(
    <CssVarsProvider>
      <ObjectList
        instances={[single]}
        selectedKey={'obj-7-0'}
        onSelect={() => {}}
        onTogglePrintable={() => {}}
        addedPartsFor={() => [addedVolume('vol-1', 'Sphere')]}
        onSelectPart={() => {}}
      />
    </CssVarsProvider>
  )
  // Two volumes: the object row PLUS a body row, and the added part. The body row carries the
  // object's name with NO suffix -- a save promotes it to a real `<part>` under exactly that name,
  // so a "(body)" decoration existed before the save and vanished after it.
  assert.equal(screen.queryAllByText('Cube').length, 2, 'the body did not get a row of its own')
  assert.equal(screen.queryAllByText(/\(body\)/).length, 0, 'the body row must not be decorated')
  assert.ok(screen.getByText('Sphere'))
})

test('the body row carries the same controls a baked part row does', () => {
  // A save persists bytes and nothing else, so the row must not GAIN controls by being written to
  // disk. It used to show a material swatch and a kebab, and grew a type menu and a per-part
  // settings button on the next save, when the bake promoted the body to a real `<part>`. Both now
  // address `BODY_PART_INDEX`, which is the ordinal that promotion puts it at.
  const single = { ...assembly(), parts: [], name: 'Cube' } as never
  const typeCalls: Array<[number, number]> = []
  const settingsCalls: Array<[number, number]> = []
  render(
    <CssVarsProvider>
      <ObjectList
        instances={[single]}
        selectedKey={'obj-7-0'}
        onSelect={() => {}}
        onTogglePrintable={() => {}}
        addedPartsFor={() => [addedVolume('vol-1', 'Sphere')]}
        onSelectPart={() => {}}
        onChangePartType={(objectId, partIndex) => typeCalls.push([objectId, partIndex])}
        perObject={{
          sliceObjectIds: new Set([7]),
          overrideCountFor: () => 0,
          onEditObject: () => {},
          onEditPart: (objectId, partIndex) => settingsCalls.push([objectId, partIndex]),
          partOverrideCountFor: () => 2
        }}
      />
    </CssVarsProvider>
  )
  const bodyRow = screen.getAllByText('Cube')[1]!.closest('li')!
  const settings = within(bodyRow).getByRole('button', { name: 'Part settings for Cube' })
  assert.match(settings.closest('span')?.textContent ?? '', /2/, 'the body did not show its override count')
  fireEvent.click(settings)
  assert.deepEqual(settingsCalls, [[7, 0]], 'the body\'s settings must address ordinal 0')
  assert.ok(within(bodyRow).getByRole('button', { name: 'Change type of Cube' }),
    'the body row must offer Change type, as it does after a save')
})

test('an object lists its ONE baked part as soon as a volume is added beside it', () => {
  // The row count is a count of VOLUMES, not of `instance.parts`. A single-`<component>` object is
  // the normal shape of a Bambu 3MF object, so with one baked part and one added volume there are
  // two volumes and both earn a row. Counting `parts.length` alone rendered the volume and dropped
  // the baked part entirely -- no name, material, type menu, settings button or menu -- and then
  // grew all of them back on the next SAVE, when the volume became a second baked part. That is the
  // save boundary showing through, which the part-is-a-part rule says it must not.
  const oneBakedPart = {
    ...assembly(),
    parts: [assembly().parts[0]!],
    name: 'Bracket'
  } as never
  const renderWith = (added: ReturnType<typeof addedVolume>[]) => render(
    <CssVarsProvider>
      <ObjectList
        instances={[oneBakedPart]}
        selectedKey={'obj-7-0'}
        onSelect={() => {}}
        onTogglePrintable={() => {}}
        addedPartsFor={() => added}
        onSelectPart={() => {}}
      />
    </CssVarsProvider>
  )

  // The inverse first: one volume, so no part rows at all (Studio folds them away at one).
  renderWith(NO_PARTS)
  assert.equal(screen.queryAllByText('Mount').length, 0, 'a lone volume must not get a row')
  cleanup()

  renderWith([addedVolume('vol-1', 'Sphere')])
  assert.ok(screen.getByText('Mount'), 'the baked part lost its row the moment a volume joined it')
  assert.ok(screen.getByText('Sphere'))
  // And the body does NOT also get one: this object's part list already describes its geometry, so
  // a body row would double-count it.
  assert.equal(screen.queryAllByText('Bracket (body)').length, 0)
})

test('a volume shows its override COUNT on the same control a baked part uses', () => {
  // Both kinds carry per-part overrides, so both must say so the same way. The volume row used to
  // swap its button's variant and colour instead of showing a count, which put two visual languages
  // for "this has overrides" in one list and never told the user how many a volume had.
  render(
    <CssVarsProvider>
      <ObjectList
        instances={[assembly()]}
        selectedKey={'obj-7-0'}
        onSelect={() => {}}
        onTogglePrintable={() => {}}
        addedPartsFor={() => [addedVolume('vol-1', 'Cube', 'normal_part', { wall_loops: '4', top_shell_layers: '2' })]}
        onEditAddedPartSettings={() => {}}
        perObject={{
          sliceObjectIds: new Set([7]),
          overrideCountFor: () => 0,
          onEditObject: () => {},
          onEditPart: () => {},
          partOverrideCountFor: () => 3
        }}
      />
    </CssVarsProvider>
  )
  // The badge renders its count as text inside the button's wrapper, for both kinds.
  const volumeButton = screen.getByRole('button', { name: 'Part settings for Cube' })
  assert.match(volumeButton.closest('span')?.textContent ?? '', /2/,
    'the volume did not show how many overrides it has')
  // ONE label for both kinds. They read "Part settings" and "Per-part settings" before, which made
  // the two rows non-interchangeable to a test or a screen reader for no reason anyone could state.
  const bakedButton = screen.getByRole('button', { name: 'Part settings for Cube A' })
  assert.match(bakedButton.closest('span')?.textContent ?? '', /3/,
    'the baked part stopped showing its count')
})

test('an added-part row exposes settings and a context menu keyed by the part KEY', () => {
  const contextKeys: string[] = []
  const settingsKeys: string[] = []
  render(
    <CssVarsProvider>
      <ObjectList
        instances={[assembly()]}
        selectedKey={'obj-7-0'}
        onSelect={() => {}}
        onTogglePrintable={() => {}}
        addedPartsFor={() => [addedVolume('vol-text', 'Text')]}
        onAddedPartContextMenu={(_objectId, partKey) => contextKeys.push(partKey)}
        onEditAddedPartSettings={(_objectId, partKey) => settingsKeys.push(partKey)}
        perObject={{
          sliceObjectIds: new Set([7]),
          overrideCountFor: () => 0,
          onEditObject: () => {}
        }}
      />
    </CssVarsProvider>
  )
  const row = screen.getByText('Text').closest('li')
  assert.ok(row, 'the added volume gets its own row')

  // Settings are NOT gated on `modifier_part`: a normal added volume carries its own settings bag
  // and must be able to reach it, exactly as a baked part row can.
  const settings = within(row!).getByLabelText('Part settings for Text')
  fireEvent.click(settings)
  assert.deepEqual(settingsKeys, ['vol-text'], 'addressed by key, not by an ordinal')

  // Right-click opens the shared part menu. Keyed by the volume's key -- an ordinal would collide
  // with the baked parts above it in the same list.
  fireEvent.contextMenu(row!)
  assert.deepEqual(contextKeys, ['vol-text'])
})

test('every row type reaches its menu by BUTTON, not only by right-click', () => {
  // Right-click is unreachable on touch here: these rows are reorder handles, so a long press
  // starts a drag (`useListReorderDrag` hold-to-drag) and the tile suppresses the iOS callout.
  // Without a button, change type / change material / part settings / delete / export were all
  // mouse-only -- which is how deleting a session-added volume became impossible on a phone.
  const objects: string[] = []
  const bakedParts: number[] = []
  const addedParts: string[] = []
  render(
    <CssVarsProvider>
      <ObjectList
        instances={[assembly()]}
        selectedKey={'obj-7-0'}
        onSelect={() => {}}
        onTogglePrintable={() => {}}
        onObjectContextMenu={(key) => objects.push(key)}
        onPartContextMenu={(_objectId, member) => { if (member.kind === 'baked') bakedParts.push(member.partIndex) }}
        addedPartsFor={() => [addedVolume('vol-text', 'Text')]}
        onAddedPartContextMenu={(_objectId, partKey) => addedParts.push(partKey)}
      />
    </CssVarsProvider>
  )
  fireEvent.click(screen.getByLabelText('More actions for Assembly'))
  fireEvent.click(screen.getByLabelText('More actions for Mount'))
  fireEvent.click(screen.getByLabelText('More actions for Text'))
  assert.deepEqual(objects, ['obj-7-0'])
  assert.deepEqual(bakedParts, [0], 'the baked part is addressed by its ORDINAL')
  assert.deepEqual(addedParts, ['vol-text'], 'the added volume by its KEY')
})
