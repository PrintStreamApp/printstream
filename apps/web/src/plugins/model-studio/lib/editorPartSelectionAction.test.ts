import assert from 'node:assert/strict'
import test from 'node:test'
import type { StagedImport } from '@printstream/shared'
import type { GizmoMode } from '../editorGeometry'
import { instanceFromStagedImport, seedEmptyEditorState, type EditorState } from './editorModel'
import { ownerPartMembers, selectEditorPart } from './editorPartSelectionAction'
import type { PartRef, PartSelection } from './selectionModel'

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'host', name: 'Host', format: 'stl', triangleCount: 2, bounds,
  parts: [
    { name: 'Body', triangleCount: 1, bounds, subtype: null },
    { name: 'Helper', triangleCount: 1, bounds, subtype: 'modifier_part' }
  ]
}

test('plain part click uses the gizmo and a repeat click returns to object selection', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(instance)
  const gizmoPartRef = { current: null as PartRef | null }
  const selectedKeyRef = { current: null as string | null }
  const partAnchorRef = { current: null as PartRef | null }
  let mode: GizmoMode = 'cut'
  let exclusiveCalls = 0
  const options: Parameters<typeof selectEditorPart>[0] = {
    objectId: instance.source.kind === 'import' ? instance.source.replacedObjectId! : 0,
    member: { kind: 'baked' as const, partIndex: 1 },
    modifiers: { additive: false, range: false }, instanceKey: instance.key,
    stateRef: { current: state }, gizmoPartRef, selectedKeyRef, partAnchorRef,
    gizmoModeRef: { current: 'cut' as const },
    selectExclusive: (key: string) => { exclusiveCalls += 1; selectedKeyRef.current = key },
    setGizmoPart: (next: PartRef | null | ((current: PartRef | null) => PartRef | null)) => {
      gizmoPartRef.current = typeof next === 'function' ? next(gizmoPartRef.current) : next
    },
    setSelectedKey: () => assert.fail('plain part click entered bulk selection'),
    setExtraSelectedKeys: () => assert.fail('plain part click changed extra object selection'),
    setPartSelection: () => assert.fail('plain part click entered bulk selection'),
    setGizmoMode: (next) => { mode = typeof next === 'function' ? next(mode) : next }
  }

  selectEditorPart(options)
  assert.equal(exclusiveCalls, 1)
  assert.deepEqual(gizmoPartRef.current, { objectId: options.objectId, member: options.member })
  assert.deepEqual(partAnchorRef.current, gizmoPartRef.current)
  assert.equal(mode, 'select')

  selectEditorPart(options)
  assert.equal(gizmoPartRef.current, null)
  assert.equal(exclusiveCalls, 1)
})

test('Ctrl click seeds bulk selection from the gizmo before queued state clears it', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(instance)
  const objectId = instance.source.kind === 'import' ? instance.source.replacedObjectId! : 0
  const first: PartRef = { objectId, member: { kind: 'baked', partIndex: 0 } }
  const gizmoPartRef = { current: first as PartRef | null }
  const queued = { current: null as ((current: PartSelection | null) => PartSelection | null) | null }
  let selectedKey: string | null = instance.key

  selectEditorPart({
    objectId, member: { kind: 'baked', partIndex: 1 },
    modifiers: { additive: true, range: false }, instanceKey: instance.key,
    stateRef: { current: state }, gizmoPartRef,
    selectedKeyRef: { current: instance.key }, partAnchorRef: { current: first },
    gizmoModeRef: { current: 'select' },
    selectExclusive: () => assert.fail('Ctrl click replaced object selection'),
    setGizmoPart: (next) => {
      gizmoPartRef.current = typeof next === 'function' ? next(gizmoPartRef.current) : next
    },
    setSelectedKey: (next) => { selectedKey = typeof next === 'function' ? next(selectedKey) : next },
    setExtraSelectedKeys: () => {},
    setPartSelection: (next) => { if (typeof next === 'function') queued.current = next },
    setGizmoMode: () => {}
  })

  assert.equal(gizmoPartRef.current, null)
  assert.equal(selectedKey, null)
  assert.ok(queued.current)
  const bulk = queued.current(null)
  assert.deepEqual(bulk?.members, [first.member, { kind: 'baked', partIndex: 1 }])
})

test('shift range follows sidebar order across baked and session-added parts', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(instance)
  const objectId = instance.source.kind === 'import' ? instance.source.replacedObjectId! : 0
  state.addedParts = { [objectId]: [{ key: 'extra' }] } as unknown as EditorState['addedParts']
  const ordered = ownerPartMembers(instance, state)
  assert.deepEqual(ordered, [
    { kind: 'baked', partIndex: 0 }, { kind: 'baked', partIndex: 1 },
    { kind: 'added', key: 'extra' }
  ])
  const anchor: PartRef = { objectId, member: { kind: 'baked', partIndex: 0 } }
  const bulk = { current: null as PartSelection | null }
  selectEditorPart({
    objectId, member: { kind: 'added', key: 'extra' },
    modifiers: { additive: false, range: true }, instanceKey: instance.key,
    stateRef: { current: state }, gizmoPartRef: { current: null },
    selectedKeyRef: { current: null }, partAnchorRef: { current: anchor },
    gizmoModeRef: { current: 'select' },
    selectExclusive: () => assert.fail('range click selected an object'),
    setGizmoPart: () => {}, setSelectedKey: () => {}, setExtraSelectedKeys: () => {},
    setPartSelection: (next) => { bulk.current = typeof next === 'function' ? next(bulk.current) : next },
    setGizmoMode: () => {}
  })
  assert.deepEqual(bulk.current?.members, ordered)
})
