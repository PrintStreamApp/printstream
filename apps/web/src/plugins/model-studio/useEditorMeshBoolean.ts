/**
 * The editor's mesh boolean: operand lists, the target mode, and the apply for both of Studio's
 * modes.
 *
 * Its own hook for the reason `useEditorPaint` and `useEditorHistory` are: this is ~500 lines of
 * state, rules and one long async commit, and `EditorView` is already the file the plugin guide
 * warns about. Keeping it here also means the pieces worth testing are reachable -- the rules that
 * do not need a scene live in `lib/meshBoolean.ts` and `lib/meshBooleanCore.ts` and are covered
 * there; what remains here is the part that genuinely needs the live render groups.
 *
 * OWNS: the operation, the A/B/working lists, "keep the originals", "solid parts only", the frozen
 * entry target, and the two apply paths. It owns no geometry and no scene: it reads render groups
 * through the refs the caller passes and writes back through the caller's setters, so the editor
 * stays the single owner of scene state.
 *
 * The evaluation itself runs OFF the main thread (`lib/meshBooleanClient.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import * as THREE from 'three'
import {
  canonicalThreeMfPartSubtype,
  isNonRenderableThreeMfPartSubtype,
  threeMfPartSubtypeCarriesFilament,
  type SceneEditPartSubtype
} from '@printstream/shared'
import { toast } from '../../lib/toast'
import { RESTING_GIZMO_MODE, partGroupRef, type GizmoMode } from './editorGeometry'
import {
  addedPartHostId,
  effectiveAddedParts,
  replaceInstanceGeometry,
  instanceFromStagedImport,
  withRemovedParts,
  type EditorAddedPart,
  type EditorInstance,
  type EditorState
} from './lib/editorModel'
import {
  collectWorldTriangles,
  rebaseTriangleSoup,
  shiftTriangleSoup,
  triangleSoupToBinaryStl
} from './lib/meshCut'
import { toObjectLocalSoup } from './lib/meshBooleanCore'
import {
  assignMeshBooleanList,
  EMPTY_MESH_BOOLEAN_LISTS,
  evaluateMeshBoolean,
  MeshBooleanOpenOperandError,
  meshBooleanOperandParticipates,
  meshBooleanPartOperandKey,
  meshBooleanTargetMode,
  parseMeshBooleanPartOperand,
  planMeshBooleanConsumption,
  pruneMeshBooleanLists,
  seedMeshBooleanLists,
  validateMeshBoolean,
  type MeshBooleanConsumptionPlan,
  type MeshBooleanLists,
  type MeshBooleanOperation,
  type MeshBooleanTargetMode
} from './lib/meshBoolean'
import type { EditorImportStore } from './lib/editorImportStore'
import type { PartRef } from './lib/selectionModel'

/** Everything the boolean reads from, or writes back into, the editor it runs inside. */
export interface EditorMeshBooleanParams {
  gizmoMode: GizmoMode
  setGizmoMode: (mode: GizmoMode) => void
  selectedKey: string | null
  extraSelectedKeys: ReadonlyArray<string>
  /** Reads refs, so the selection STATE above is what actually moves the operands. */
  allSelectedKeys: () => string[]
  activePlateIndex: number
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  setState: (updater: (current: EditorState | null) => EditorState | null) => void
  importStore: EditorImportStore
  recordHistoryRef: MutableRefObject<() => void>
  collectHelperVolumesFor: (instance: EditorInstance, group: THREE.Group) => Array<{
    soup: Float32Array
    subtype: SceneEditPartSubtype
    name: string
    filamentId: number | null
  }>
  /** The instance group's rotation carrier; object space is its local space. */
  rotorOf: (group: THREE.Group) => THREE.Object3D
  nextInstanceKey: () => string
  setSelectedKey: (key: string | null) => void
  setExtraSelectedKeys: (keys: string[]) => void
  setPartSelection: (selection: null) => void
  /** The single part holding the gizmo, of either kind: an apply clears or re-points it. */
  setGizmoPart: (part: PartRef | null) => void
  setAddedPartMeshVersion: (updater: (version: number) => number) => void
  setRebuildToken: (updater: (token: number) => number) => void
  regenerateActiveThumbnailRef: MutableRefObject<(() => void) | null>
  /** Bumped whenever `state.addedParts` is mutated in place; keys the helper-volume count. */
  addedPartMeshVersion: number
  rebuildToken: number
}

/** What the tool rail and `MeshBooleanPanel` need. */
export interface EditorMeshBoolean {
  operation: MeshBooleanOperation
  setOperation: (next: MeshBooleanOperation) => void
  targetMode: MeshBooleanTargetMode
  lists: MeshBooleanLists
  nameFor: (operand: string) => string
  assignList: (operand: string, target: 'a' | 'b') => void
  keepOriginals: boolean
  setKeepOriginals: (next: boolean) => void
  helperVolumeCount: number
  solidPartsOnly: boolean
  setSolidPartsOnly: (next: boolean) => void
  warning: string | null
  busy: boolean
  apply: () => void
}

export function useEditorMeshBoolean({
  gizmoMode,
  setGizmoMode,
  selectedKey,
  extraSelectedKeys,
  allSelectedKeys,
  activePlateIndex,
  stateRef,
  groupByKeyRef,
  setState,
  importStore,
  recordHistoryRef,
  collectHelperVolumesFor,
  rotorOf,
  nextInstanceKey,
  setSelectedKey,
  setExtraSelectedKeys,
  setPartSelection,
  setGizmoPart,
  setAddedPartMeshVersion,
  setRebuildToken,
  regenerateActiveThumbnailRef,
  addedPartMeshVersion,
  rebuildToken
}: EditorMeshBooleanParams): EditorMeshBoolean {
  // Mesh boolean. The operand lists live here rather than in the panel because they must survive a
  // selection change (pruned, not reset) and because Apply reads them alongside the scene.
  const [booleanOperation, setBooleanOperation] = useState<MeshBooleanOperation>('union')
  // Null means "the tool is not open", which is ALSO how the effect below knows to seed rather than
  // prune. Keeping that in the state itself rather than in a companion ref is deliberate: a ref read
  // from inside the functional updater is read during a LATER render, by which time the line setting
  // it has already run, so the seed branch was dead and the A/B lists stayed empty for the whole
  // session -- Difference could never be run, `Apply` permanently disabled with both lists reading
  // "Nothing here yet.". Here the updater reads only its own argument, so it cannot go stale.
  const [booleanLists, setBooleanLists] = useState<MeshBooleanLists | null>(null)
  const [booleanKeepOriginals, setBooleanKeepOriginals] = useState(false)
  // Studio's `entity_only`, same default: a helper volume is an AID, so the expected answer is that
  // it marks a region of the result rather than becoming part of its shape.
  const [booleanSolidPartsOnly, setBooleanSolidPartsOnly] = useState(true)
  const [booleanBusy, setBooleanBusy] = useState(false)
  /** Mode + host as they were when the tool opened; null while it is closed. See `booleanTarget`. */
  const booleanEntryTargetRef = useRef<{ mode: MeshBooleanTargetMode; hostKey: string | null } | null>(null)
  /**
   * The tool's target mode and its operands, decided together on entry.
   *
   * Several objects boolean as OBJECTS; one object with two or more parts booleans its PARTS, which
   * is Studio's `update_cur_mode`. Part mode enumerates the object's parts rather than reading the
   * selection, and enumerates BOTH kinds uniformly: a baked part and a session-added volume are the
   * same thing to everything downstream (see the part-is-a-part rule in this plugin's development notes),
   * and reading the selection instead would have supported only baked ones, since an added volume
   * cannot join a multi-part selection today.
   */
  const booleanTarget = useMemo((): { mode: MeshBooleanTargetMode; hostKey: string | null; operands: string[] } => {
    if (gizmoMode !== 'meshBoolean') return { mode: 'object', hostKey: null, operands: [] }
    const objectKeys = allSelectedKeys()
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const soleKey = objectKeys.length === 1 ? objectKeys[0]! : null
    const sole = soleKey ? plate?.instances.find((entry) => entry.key === soleKey) : undefined
    // `instance.parts` is EMPTY for a single-solid import (`instanceFromStagedImport` only fills it
    // past one solid), and its body then lives on the instance's own mesh rather than in any part.
    // Such an object is described by its BODY plus its added volumes, which is why the body is an
    // operand kind: without it, part mode here could only boolean the added volumes against each
    // other and would silently leave out the very body the user was cutting.
    //
    // The body appears for exactly the objects whose part list does not already describe them. On an
    // object that HAS parts, the parts are the geometry and a body operand would double-count it.
    // `bodyRemoved` is the same gate the sidebar's rows use: a deleted body is not a volume any
    // more, so listing it here made the panel and the sidebar disagree about what the object is
    // made of, and applying it collected a zero-length soup and failed with "no printed geometry".
    const parts = sole
      ? [
        ...(sole.parts.length === 0 && !sole.bodyRemoved ? [meshBooleanPartOperandKey({ kind: 'body' })] : []),
        ...sole.parts.map((part) => meshBooleanPartOperandKey({ kind: 'baked', partIndex: part.partIndex })),
        ...effectiveAddedParts(stateRef.current, sole).map((part) => meshBooleanPartOperandKey({ kind: 'added', key: part.key }))
      ]
      : []
    // The mode and host are FROZEN on entry (`booleanEntryTargetRef`), not re-derived per render.
    // Ctrl-clicking an operand away mid-session can otherwise take a two-object selection down to
    // one multi-part object, which would flip object mode to part mode: every operand key changes
    // address space, so the prune drops the user's whole A/B assignment and the panel silently
    // re-words itself from "Objects" to "Parts". Freezing is also what makes the prune-not-reseed
    // design coherent -- it can only preserve assignments within one address space.
    const frozen = booleanEntryTargetRef.current
    if (!frozen) {
      // First render of a session: decide, and freeze. Written during render on purpose -- the
      // decision must be in place before the seed effect reads `operands`, and an effect would run
      // a frame later, seeding the lists against a mode that then changed under them.
      const decided = meshBooleanTargetMode({ objects: objectKeys.length, partsInOneObject: parts.length })
      booleanEntryTargetRef.current = { mode: decided, hostKey: decided === 'part' ? soleKey : null }
    }
    const { mode, hostKey } = booleanEntryTargetRef.current!
    return mode === 'part'
      // The host is fixed for the session; if the selection moved off it there are no operands
      // rather than someone else's parts.
      ? { mode, hostKey, operands: hostKey != null && hostKey === soleKey ? parts : [] }
      : { mode, hostKey: null, operands: objectKeys }
    // `allSelectedKeys` reads refs, so the selection state is what actually moves this;
    // `addedPartMeshVersion` is what moves the added-part half, which is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gizmoMode, selectedKey, extraSelectedKeys, allSelectedKeys, activePlateIndex, addedPartMeshVersion, rebuildToken])
  const booleanOperands = booleanTarget.operands
  // Read through a ref by the callbacks below, which are memoised on the plate rather than on the
  // target: the host cannot change while the tool is open (the mode is decided on entry).
  const booleanHostKeyRef = useRef<string | null>(null)
  booleanHostKeyRef.current = booleanTarget.hostKey
  // Seed on entering the tool, prune while inside it: entering should follow the selection exactly
  // (Studio re-inits its lists on a selection change), but a mid-session Ctrl-click must not discard
  // an A/B assignment the user made for the operands that are still there.
  useEffect(() => {
    if (gizmoMode !== 'meshBoolean') {
      booleanEntryTargetRef.current = null
      setBooleanLists(null)
      return
    }
    setBooleanLists((current) => (current
      ? pruneMeshBooleanLists(current, booleanOperands)
      : seedMeshBooleanLists(booleanOperands)))
  }, [gizmoMode, booleanOperands])
  // A shared constant, not a fresh `{...}`, so the panel's prop identity is stable across the
  // renders between opening the tool and the seed landing.
  const booleanListsOrEmpty = booleanLists ?? EMPTY_MESH_BOOLEAN_LISTS

  const booleanWarning = useMemo(() => validateMeshBoolean(booleanOperation, booleanTarget.mode, {
    working: booleanListsOrEmpty.working.length,
    listA: booleanListsOrEmpty.a.length,
    listB: booleanListsOrEmpty.b.length
  }), [booleanOperation, booleanTarget.mode, booleanListsOrEmpty])

  /**
   * An operand part's subtype, for either kind of part.
   *
   * The one place the two address spaces are read side by side, so everything above it can ask what
   * KIND of volume an operand is without caring which of them it happens to be.
   */
  const booleanPartSubtype = useCallback((host: EditorInstance, operand: string): SceneEditPartSubtype | null => {
    const part = parseMeshBooleanPartOperand(operand)
    if (!part) return null
    // The body is printed geometry by definition -- an object's own mesh cannot be a helper volume
    // -- so it is never filtered out by the solid-parts toggle.
    if (part.kind === 'body') return 'normal_part'
    const subtype = part.kind === 'baked'
      ? host.parts.find((entry) => entry.partIndex === part.partIndex)?.subtype
      : effectiveAddedParts(stateRef.current, host).find((entry) => entry.key === part.key)?.subtype
    return canonicalThreeMfPartSubtype(subtype ?? null)
  }, [stateRef])

  /** An operand's sidebar name, whichever of the four things the key addresses. */
  const booleanNameFor = useCallback((operand: string) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const part = parseMeshBooleanPartOperand(operand)
    if (!part) return plate?.instances.find((entry) => entry.key === operand)?.name ?? operand
    const host = booleanHostKeyRef.current
      ? plate?.instances.find((entry) => entry.key === booleanHostKeyRef.current)
      : undefined
    if (!host) return operand
    // The body has no name of its own: it IS the object, so it is named as the object, which is
    // also what the sidebar row for such an instance shows.
    if (part.kind === 'body') return host.name
    return (part.kind === 'baked'
      ? host.parts.find((entry) => entry.partIndex === part.partIndex)?.name
      : effectiveAddedParts(stateRef.current, host).find((entry) => entry.key === part.key)?.name)
      ?? operand
  }, [activePlateIndex, stateRef])

  // How many helper volumes the operands carry, which is the only thing that decides whether the
  // solid-parts toggle is shown at all (Studio hides its own on the same test). Keyed on the mesh
  // version as well as the operands, since `addedParts` is mutated in place on a ref.
  const booleanHelperVolumeCount = useMemo(() => {
    if (gizmoMode !== 'meshBoolean') return 0
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    // In PART mode a helper volume is an operand in its own right, so the count is how many of the
    // operands are helpers; in object mode it is how many the operand objects CARRY.
    if (booleanTarget.mode === 'part') {
      const host = booleanTarget.hostKey
        ? plate?.instances.find((entry) => entry.key === booleanTarget.hostKey)
        : undefined
      if (!host) return 0
      return booleanOperands.filter((key) => {
        const subtype = booleanPartSubtype(host, key)
        return subtype != null && isNonRenderableThreeMfPartSubtype(subtype)
      }).length
    }
    // COUNTED, not collected: `collectHelperVolumesFor` world-bakes every volume's triangles, and
    // this memo re-runs on each selection change, rebuild and added-part bump while the tool is
    // open. Taking `.length` off that allocated megabytes per keystroke-ish event for a number the
    // tags already answer. The parent test is the same de-duplication that function makes: a baked
    // helper part tags BOTH its group and the mesh inside it.
    return booleanOperands.reduce((total, key) => {
      const group = groupByKeyRef.current.get(key)
      if (!group) return total
      let count = 0
      group.traverse((node) => {
        if (node.userData.isHelperVolume !== true) return
        if (node.parent?.userData.isHelperVolume === true) return
        count += 1
      })
      return total + count
    }, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gizmoMode, booleanOperands, booleanTarget, activePlateIndex, addedPartMeshVersion, rebuildToken, collectHelperVolumesFor])

  const handleAssignBooleanList = useCallback((operand: string, target: 'a' | 'b') => {
    // Null means the tool is not open, so there is no row to have been clicked: leave it alone
    // rather than seeding a list from a gesture that cannot have happened.
    setBooleanLists((current) => (current ? assignMeshBooleanList(current, operand, target) : current))
  }, [])

  /**
   * Land a PART-mode boolean: the result becomes a volume of the host object, and the volumes it
   * consumed leave it.
   *
   * Mirrors Studio's part-mode apply, where the result replaces the first A volume ON THE SAME
   * OBJECT rather than becoming a new object. Ours arrives as a session-added volume, which is the
   * editor's only way to add geometry to an object without a save -- and is exactly what the
   * part-is-a-part rule requires, since a baked part and an added one are the same thing to every
   * surface that renders, exports, or bakes them.
   *
   * The frame is the fiddly bit. `result` is WORLD space, while an added part's soup is read
   * relative to the object (the mesh hangs on the rotor, whose local space IS 3MF object space), so
   * the triangles are pulled back through the rotor's inverse and the placement left at identity.
   * Staged as `part`, never `object`: `object` normalisation re-centres XY and floors Z, which would
   * slide the result off the geometry it was cut from.
   */
  const applyPartModeBoolean = useCallback(async ({
    host, hostGroup, result, listA, plan, solidPartsOnly, excludedHelperOperands
  }: {
    host: EditorInstance
    hostGroup: THREE.Group
    result: Float32Array
    listA: ReadonlyArray<string>
    plan: MeshBooleanConsumptionPlan
    solidPartsOnly: boolean
    /** Operands the solid-parts toggle kept OUT of the boolean, which therefore stay on the object. */
    excludedHelperOperands: ReadonlyArray<string>
  }) => {
    const hostId = addedPartHostId(host)
    if (hostId == null) return
    const rotor = rotorOf(hostGroup)
    // Stale until asked: the rotor's world matrix is only recomputed on render, and this runs after
    // an await.
    rotor.updateWorldMatrix(true, false)
    const soup = toObjectLocalSoup(result, new THREE.Matrix4().copy(rotor.matrixWorld).invert())
    const sourceName = booleanNameFor(listA[0] ?? '')
    // Whether the object's OWN geometry was one of the shapes consumed. If it was, the result IS the
    // object's new body and replaces it, whichever side of the boolean the body was on: leaving the
    // result as a volume ADDED to an object whose body has just been consumed would produce an
    // object with no geometry of its own, which nothing downstream can render, bake or slice.
    const bodyConsumed = plan.consumed.some((key) => parseMeshBooleanPartOperand(key)?.kind === 'body')
    const staged = await importStore.stageFile(new File(
      [triangleSoupToBinaryStl(soup)],
      // The body replacement keeps the object's own name (`replaceInstanceGeometry` restores it), so
      // only the volume case needs the `_Boolean` suffix Studio gives its results.
      bodyConsumed ? `${host.name}.stl` : `${sourceName}_Boolean.stl`,
      { type: 'application/octet-stream' }
    ), 'part')
    // Studio forces the result to MODEL_PART whatever the sources were, and inherits the first
    // source's material. A helper volume can only be a source with the solid-parts toggle OFF, and
    // the thing it produced is printed geometry either way.
    const sourcePart = parseMeshBooleanPartOperand(listA[0] ?? '')
    const sourceFilament = sourcePart?.kind === 'baked'
      ? host.parts.find((entry) => entry.partIndex === sourcePart.partIndex)?.filamentId ?? null
      : sourcePart?.kind === 'added'
        ? effectiveAddedParts(stateRef.current, host).find((entry) => entry.key === sourcePart.key)?.filamentId ?? null
        : null
    const consumed = new Set(plan.consumed)
    const consumedBaked = new Set<number>()
    const consumedAdded = new Set<string>()
    for (const key of consumed) {
      const part = parseMeshBooleanPartOperand(key)
      if (part?.kind === 'baked') consumedBaked.add(part.partIndex)
      else if (part?.kind === 'added') consumedAdded.add(part.key)
    }
    const addedPart: EditorAddedPart = {
      key: nextInstanceKey(),
      importId: staged.importId,
      subtype: 'normal_part',
      name: `${sourceName}_Boolean`,
      ...(sourceFilament != null ? { filamentId: sourceFilament } : {}),
      // Identity: the triangles are already in the object's own frame.
      position: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
      soup
    }
    // One commit for the whole thing, and one history entry, so a single undo puts every consumed
    // volume back AND takes the result away. `withRemovedParts` is told about the replacement, or it
    // would refuse a boolean that consumed the object's only printed part -- which is the common
    // case, since that is usually what you are booleaning.
    // Decided BEFORE the commit, off `stateRef`, never from inside the updater. `withRemovedParts`
    // returns null when the host can no longer be resolved (it left the plate while the staging
    // await was in flight), and that has to be known here: a flag set inside a functional updater
    // and read after `setState` is the trap this file documents at `booleanLists` -- React runs the
    // updater during a LATER render, so the read is of the value before it ran.
    const before = stateRef.current
    if (!before) return
    const survivingAdded = effectiveAddedParts(before, host)
      .filter((part) => !consumedAdded.has(part.key) && !isNonRenderableThreeMfPartSubtype(part.subtype))
      .length
    const withRemovals = consumedBaked.size > 0
      ? withRemovedParts(before, hostId, consumedBaked, survivingAdded + 1)
      : before
    if (!withRemovals) {
      // Nothing changed, so nothing claims to have, and no history entry is recorded for a no-op.
      toast.error('The object this boolean was working on is no longer on this plate.')
      return
    }
    // The result becomes the object's geometry on EVERY copy of it, not just the one that was
    // clicked: geometry is object-level, so a linked copy left on the pre-boolean mesh would render
    // a shape the object no longer has while still reporting as a copy of it, and the save would
    // then emit two different imports claiming one identity. Built out here, and once per instance,
    // because `replaceInstanceGeometry` MINTS AN INSTANCE KEY and each copy has to land on its own
    // placement; minting inside the updater below would break its purity (see `nextInstanceKey`).
    const replacements = new Map<string, EditorInstance>()
    if (bodyConsumed) {
      for (const plate of before.plates) {
        for (const entry of plate.instances) {
          if (addedPartHostId(entry) !== hostId) continue
          // `centerOn` is null for the same reason the import is staged as `part`: the triangles are
          // already where they belong, so re-centring the object onto its old footprint would move a
          // result whose whole point is that it lines up with what it replaced.
          replacements.set(entry.key, replaceInstanceGeometry(entry, staged, hostId, importStore.meshUrl, null))
        }
      }
    }
    /**
     * Commit onto the LIVE state, not the `before` snapshot the decisions were made from.
     *
     * Everything above ran after two awaits -- the evaluate (which has a 60s-plus deadline of its
     * own on a dense model) and the upload -- and the viewport stays interactive throughout, so a
     * move, a rename, a plate change, an undo or a paint stroke can land in that window.
     * Re-applying the removals to `current` composes with whatever arrived; committing
     * `withRemovals` wholesale threw it away.
     */
    const commit = (current: EditorState | null): EditorState | null => {
      if (!current) return current
      const removed = consumedBaked.size > 0
        ? withRemovedParts(current, hostId, consumedBaked, survivingAdded + 1)
        : current
      if (!removed) return current
      const nextAddedParts = { ...(removed.addedParts ?? {}) }
      const nextSurvivors = (nextAddedParts[hostId] ?? []).filter((part) => !consumedAdded.has(part.key))
      if (!bodyConsumed) {
        nextAddedParts[hostId] = [...nextSurvivors, addedPart]
        return { ...removed, addedParts: nextAddedParts }
      }
      if (nextSurvivors.length > 0) nextAddedParts[hostId] = nextSurvivors
      else delete nextAddedParts[hostId]
      return {
        ...removed,
        addedParts: nextAddedParts,
        plates: removed.plates.map((entry) => ({
          ...entry,
          instances: entry.instances.map((item) => replacements.get(item.key) ?? item)
        }))
      }
    }
    if (bodyConsumed) {
      // The result becomes the object's geometry, through the same seam Replace and the text tool
      // use, which RETAINS the object identity (`replacedObjectId`). That is what keeps the volumes
      // this boolean did not consume attached: they are keyed by that identity, and their
      // coordinates are object-local, which the result shares because it was rebased into the
      // rotor's frame above. So this deliberately does NOT call `dropAddedPartsForReplacedHost` --
      // that exists for a swap to UNRELATED geometry, where the old shape's blockers would land on
      // a mesh they were never drawn against; a boolean result is the same shape, minus what the
      // user just removed from it.
      recordHistoryRef.current?.()
      setState(commit)
      setPartSelection(null)
      setGizmoPart(null)
      // The replacement is a new instance key, so the old selection names nothing.
      const clickedReplacement = replacements.get(host.key)
      if (clickedReplacement) setSelectedKey(clickedReplacement.key)
      setAddedPartMeshVersion((version) => version + 1)
      setRebuildToken((token) => token + 1)
      regenerateActiveThumbnailRef.current?.()
      setGizmoMode(RESTING_GIZMO_MODE)
      const keptHelperVolumes = solidPartsOnly ? excludedHelperOperands.length : 0
      toast.success(`Applied the ${booleanOperation}.`
        + (keptHelperVolumes > 0 ? ` ${keptHelperVolumes} helper volume${keptHelperVolumes === 1 ? '' : 's'} left in place.` : ''))
      return
    }
    recordHistoryRef.current?.()
    setState(commit)
    setPartSelection(null)
    setGizmoPart({ objectId: hostId, member: { kind: 'added', key: addedPart.key } })
    setAddedPartMeshVersion((version) => version + 1)
    setRebuildToken((token) => token + 1)
    regenerateActiveThumbnailRef.current?.()
    setGizmoMode(RESTING_GIZMO_MODE)
    // Only the ones the toggle actually EXCLUDED were left in place. With it off a helper volume was
    // an operand like any other and has just been consumed, so counting it here would report the
    // opposite of what happened.
    const keptHelpers = solidPartsOnly ? excludedHelperOperands.length : 0
    toast.success(`Applied the ${booleanOperation}.`
      + (keptHelpers > 0 ? ` ${keptHelpers} helper volume${keptHelpers === 1 ? '' : 's'} left in place.` : ''))
  }, [booleanOperation, booleanNameFor, importStore, setPartSelection,
    setGizmoPart, nextInstanceKey, recordHistoryRef, regenerateActiveThumbnailRef, rotorOf,
    setAddedPartMeshVersion, setGizmoMode, setRebuildToken, setSelectedKey,
    setState, stateRef])

  /**
   * Run the boolean and stage the result, reusing the path Assemble and Cut already take: world-bake
   * the operands' triangles, hand the soup to the import store, and let it become an ordinary
   * import-backed instance. No new API surface, and it works on an unsaved import.
   *
   * PART mode is the same operation one level down, as Studio's is: the operands are volumes of one
   * object, the result becomes a volume of that same object (Studio replaces the first A volume in
   * place), and the consumed ones are removed. Both kinds of part take part on equal terms -- a
   * baked part through `removedParts`, a session-added one by dropping it from `state.addedParts` --
   * because which of them owns a mesh entry in the base file is a fact about the SAVE and nothing
   * the user can see.
   *
   * Helper volumes follow Studio's `entity_only` rule, which is `booleanSolidPartsOnly` here: on,
   * they contribute no geometry and are re-homed onto the result exactly as
   * `attach_ignored_non_models_to_target` re-homes them; off, they are booleaned as ordinary solids.
   * Which operands are consumed and whose volumes travel is `planMeshBooleanConsumption`.
   */
  const handleApplyMeshBoolean = useCallback(async () => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate) return
    const isPartMode = booleanTarget.mode === 'part'
    const host = isPartMode && booleanTarget.hostKey
      ? plate.instances.find((entry) => entry.key === booleanTarget.hostKey)
      : undefined
    const hostGroup = isPartMode && booleanTarget.hostKey ? groupByKeyRef.current.get(booleanTarget.hostKey) : undefined
    if (isPartMode && (!host || !hostGroup)) return
    const groupFor = (key: string) => groupByKeyRef.current.get(key)
    /** The render node one operand draws, for either mode and either kind of part. */
    const nodeFor = (key: string): THREE.Object3D | null => {
      if (!isPartMode) return groupFor(key) ?? null
      const part = parseMeshBooleanPartOperand(key)
      if (!part || !hostGroup) return null
      // The body is not ONE node: on an object with no parts list it is whatever hangs off the
      // rotor besides the added volumes, so it is collected from the rotor with those skipped
      // rather than located.
      if (part.kind === 'body') return rotorOf(hostGroup)
      let found: THREE.Object3D | null = null
      hostGroup.traverse((node) => {
        if (found) return
        if (part.kind === 'added') {
          if (node.userData.addedPartKey === part.key) found = node
          return
        }
        // Matched on the part GROUP, which is the only node carrying the ref: its child mesh does
        // not, so this cannot double-count the way a helper volume's twin tags would.
        const ref = partGroupRef(node)
        if (ref && ref.partIndex === part.partIndex) found = node
      })
      return found
    }
    const soupFor = (key: string) => {
      const node = nodeFor(key)
      if (!node) return null
      // With the toggle off a helper volume IS an operand solid, so it must reach the evaluator --
      // the default walk skips it, which is what makes the toggle mean anything. In part mode the
      // operand may BE a helper volume, so the same flag decides whether it contributes at all.
      return collectWorldTriangles(node, {
        includeModifierVolumes: !booleanSolidPartsOnly,
        // The body operand is collected from the whole rotor, so the added volumes sharing it have
        // to be left out or each would land on BOTH sides of the boolean at once.
        skipAddedParts: parseMeshBooleanPartOperand(key)?.kind === 'body'
      })
    }
    // Studio's `filter_volumes`: with "solid parts only" on, a helper volume contributes nothing, so
    // it must leave the OPERAND set entirely rather than reaching the evaluator as an empty soup --
    // which the closed-solid gate inside the evaluation would then reject as an unrepairable mesh.
    const participates = (key: string) => meshBooleanOperandParticipates(
      host ? booleanPartSubtype(host, key) : null,
      { solidPartsOnly: booleanSolidPartsOnly, mode: booleanTarget.mode }
    )
    const listA = (booleanOperation === 'difference' ? booleanListsOrEmpty.a : booleanListsOrEmpty.working)
      .filter(participates)
    const listB = (booleanOperation === 'difference' ? booleanListsOrEmpty.b : []).filter(participates)
    // Re-validated AFTER the filter, against the same rule the panel shows. The panel counts the
    // whole list because that is what the user picked; excluding the helper volumes can drop it
    // under the minimum, and Studio hits exactly this -- it validates unfiltered and then aborts
    // late with a bare count message. Refusing here says which rule was missed and why.
    const shortfall = validateMeshBoolean(booleanOperation, booleanTarget.mode, {
      working: listA.length, listA: listA.length, listB: listB.length
    })
    if (shortfall) {
      toast.error(`${shortfall} Its helper volumes are excluded by "Solid parts only"; turn that off to use their shapes.`)
      return
    }
    const soupsA = listA.map(soupFor)
    const soupsB = listB.map(soupFor)
    if (soupsA.some((soup) => !soup) || soupsB.some((soup) => !soup)) {
      toast.error('Some of the selected models are still loading.')
      return
    }
    // An operand can be present and rendered yet contribute NO triangles: an object whose only
    // geometry is a helper volume (which the scene build now deliberately keeps on the plate) walks
    // to an empty soup once the helpers are skipped. That is not an open mesh, and the closed-solid
    // refusal would send the user to Repair mesh, which can never fix it -- so it is caught here,
    // before the evaluation that raises that refusal.
    const emptyOperand = [...listA, ...listB].find((key, index) => {
      const soup = index < soupsA.length ? soupsA[index] : soupsB[index - soupsA.length]
      return soup != null && soup.length === 0
    })
    if (emptyOperand) {
      toast.error(`${booleanNameFor(emptyOperand)} has no printed geometry to combine.`)
      return
    }
    const plan = planMeshBooleanConsumption(
      booleanOperation,
      // The plan describes what happens to the operands that TOOK PART, so it is built from the
      // filtered lists: a helper volume left out of the boolean is also left alone on the object,
      // exactly as Studio leaves it (its part-mode delete list skips non-model parts too).
      { working: listA, a: listA, b: listB },
      { keepOriginals: booleanKeepOriginals, solidPartsOnly: booleanSolidPartsOnly }
    )
    // Collected BEFORE anything is staged: a consumed operand's volumes are addressed through an
    // instance that is about to leave the plate, exactly as in the cut. Nothing is carried in part
    // mode -- the helper volumes never left the object, so there is nowhere to carry them TO.
    const carriedVolumes = isPartMode ? [] : plan.carried.flatMap((key) => {
      const instance = plate.instances.find((entry) => entry.key === key)
      const group = groupFor(key)
      return instance && group ? collectHelperVolumesFor(instance, group) : []
    })
    const droppedCount = isPartMode ? 0 : plan.dropped.reduce((total, key) => {
      const instance = plate.instances.find((entry) => entry.key === key)
      const group = groupFor(key)
      return total + (instance && group ? collectHelperVolumesFor(instance, group).length : 0)
    }, 0)
    setBooleanBusy(true)
    try {
      const result = await evaluateMeshBoolean(
        booleanOperation,
        soupsA as Float32Array[],
        soupsB as Float32Array[]
      )
      if (result.length === 0) {
        // A real answer, not a failure: two shapes that do not touch have no intersection. Saying so
        // is the difference between "nothing happened" and "the tool broke".
        toast.warn('The result is empty: the shapes do not overlap.')
        return
      }
      if (isPartMode && host && hostGroup) {
        await applyPartModeBoolean({
          host, hostGroup, result, listA, plan,
          solidPartsOnly: booleanSolidPartsOnly,
          excludedHelperOperands: booleanListsOrEmpty.working.filter((key) => !listA.includes(key) && !listB.includes(key))
        })
        return
      }
      const { offset } = rebaseTriangleSoup(result)
      const sourceKey = listA[0]!
      const source = plate.instances.find((entry) => entry.key === sourceKey)
      const stl = triangleSoupToBinaryStl(result)
      // Studio names the result after its first source object, and inherits that object's config.
      const file = new File([stl], `${source?.name ?? 'Boolean'}_Boolean.stl`, { type: 'application/octet-stream' })
      const staged = await importStore.stageFile(file, 'object')
      const next = instanceFromStagedImport(staged, importStore.meshUrl)
      next.position.set(offset.x, offset.y, 0)
      next.filamentId = source?.filamentId ?? null
      next.printable = source?.printable ?? true
      // Each carried volume is staged as `part`, at IDENTITY: its world triangles are already baked
      // into the soup and shifted by the RESULT's own rebase, so it lands back on the geometry it
      // marks. `object` normalisation would re-centre and floor it, moving a blocker off its target.
      const carried = await Promise.all(carriedVolumes.map(async (volume) => {
        const soup = shiftTriangleSoup(volume.soup.slice(), offset)
        const stagedVolume = await importStore.stageFile(new File(
          [triangleSoupToBinaryStl(soup)],
          `${volume.name}.stl`,
          { type: 'application/octet-stream' }
        ), 'part')
        return { volume, importId: stagedVolume.importId, soup }
      }))
      const hostId = addedPartHostId(next)
      const consumed = new Set(plan.consumed)
      // Keys minted HERE, not inside the updater below: React may run a functional updater more
      // than once for one dispatch (StrictMode's double-invoke, or a re-base after a concurrent
      // update), so minting inside it hands the same volume a different identity on each run --
      // and every other structure referring to it keeps the first.
      const carriedParts: EditorAddedPart[] = carried.map(({ volume, importId, soup }) => ({
        key: nextInstanceKey(),
        importId,
        subtype: volume.subtype,
        name: volume.name,
        ...(threeMfPartSubtypeCarriesFilament(volume.subtype) && volume.filamentId != null
          ? { filamentId: volume.filamentId }
          : {}),
        position: new THREE.Vector3(),
        rotation: new THREE.Euler(),
        scale: new THREE.Vector3(1, 1, 1),
        soup
      }))
      // Hand-rolled rather than `updatePlates` for the reason the cut is: the carried volumes live
      // beside `plates` on the state root, and both must land in ONE commit or a single undo leaves
      // the volumes orphaned on a host that is gone. One `recordHistory` for the whole apply --
      // `updatePlates` would add a second, and the extra Ctrl+Z does nothing visible.
      recordHistoryRef.current?.()
      setState((current) => {
        if (!current) return current
        const addedParts = { ...(current.addedParts ?? {}) }
        if (hostId != null && carriedParts.length > 0) addedParts[hostId] = carriedParts
        return {
          ...current,
          addedParts,
          plates: current.plates.map((entry) => entry.index === activePlateIndex
            ? { ...entry, instances: [...entry.instances.filter((item) => !consumed.has(item.key)), next] }
            : entry)
        }
      })
      // `addedParts` is mutated on a ref, so nothing about the carried volumes is visible to React
      // without this; the instance list moved too, but "something else changed anyway" is the
      // reasoning that makes the next caller's omission invisible.
      setAddedPartMeshVersion((version) => version + 1)
      setRebuildToken((token) => token + 1)
      setExtraSelectedKeys([])
      setSelectedKey(next.key)
      setGizmoMode('translate')
      // Studio says nothing about either count. Volumes going missing is the user's work going away,
      // and this editor's rule (see the split tool) is to say so rather than drop them silently.
      toast.success(`Applied the ${booleanOperation}.`
        + (carried.length > 0 ? ` Kept ${carried.length} helper volume${carried.length === 1 ? '' : 's'}.` : '')
        + (droppedCount > 0
          ? ` ${droppedCount} helper volume${droppedCount === 1 ? '' : 's'} on the subtracted shape${droppedCount === 1 ? '' : 's'} could not be carried over: undo to get ${droppedCount === 1 ? 'it' : 'them'} back.`
          : ''))
    } catch (error) {
      // THE closed-solid gate's refusal, raised inside the evaluation (on the worker thread when
      // there is one) because it costs about a second on a dense operand. It knows the operand's
      // POSITION only, so naming it happens here, along with the repair that fixes it.
      if (error instanceof MeshBooleanOpenOperandError) {
        const key = [...listA, ...listB][error.operandIndex]
        toast.error(`${key ? booleanNameFor(key) : 'An operand'} is not a closed solid.`
          + ' Repair it first (right-click the object, Repair mesh).')
        return
      }
      toast.error(error instanceof Error ? error.message : 'Unable to run the boolean.')
    } finally {
      setBooleanBusy(false)
    }
  }, [activePlateIndex, booleanOperation, booleanListsOrEmpty, booleanKeepOriginals, booleanSolidPartsOnly,
    booleanNameFor, booleanPartSubtype, booleanTarget, applyPartModeBoolean, collectHelperVolumesFor,
    importStore, groupByKeyRef, nextInstanceKey, recordHistoryRef, rotorOf, setAddedPartMeshVersion,
    setExtraSelectedKeys, setGizmoMode, setRebuildToken, setSelectedKey, setState, stateRef])
  return {
    operation: booleanOperation,
    setOperation: setBooleanOperation,
    targetMode: booleanTarget.mode,
    lists: booleanListsOrEmpty,
    nameFor: booleanNameFor,
    assignList: handleAssignBooleanList,
    keepOriginals: booleanKeepOriginals,
    setKeepOriginals: setBooleanKeepOriginals,
    helperVolumeCount: booleanHelperVolumeCount,
    solidPartsOnly: booleanSolidPartsOnly,
    setSolidPartsOnly: setBooleanSolidPartsOnly,
    warning: booleanWarning,
    busy: booleanBusy,
    apply: () => { void handleApplyMeshBoolean() }
  }
}
