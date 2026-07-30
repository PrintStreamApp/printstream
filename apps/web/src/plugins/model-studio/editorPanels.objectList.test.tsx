/**
 * Part-row wiring in the object list.
 *
 * A part is addressed by its ORDINAL within its object (`partIndex`), never by
 * `componentObjectId` — that is the MESH it references, and BambuStudio writes the same id for
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
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ObjectList } = await import('./editorPanels')

afterEach(() => cleanup())
after(() => dom.window.close())

type ListProps = Parameters<typeof ObjectList>[0]
type Instance = ListProps['instances'][number]

/**
 * One object whose four parts share a single mesh id (21) after a distinct first part — the shape
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
        onSelectPart={(_objectId, partIndex) => calls.selected.push(partIndex)}
        onPartContextMenu={(_objectId, partIndex) => calls.context.push(partIndex)}
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
  fireEvent.click(screen.getByRole('button', { name: 'Per-part settings for Cube B' }))
  assert.deepEqual(calls.settings, [2])
})

test('the gizmo highlight follows the selected ordinal, not its mesh siblings', () => {
  renderList({ selectedBakedPart: { objectId: 7, partIndex: 2 } })
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
