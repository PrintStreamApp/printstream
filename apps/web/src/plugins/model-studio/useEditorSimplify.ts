/**
 * Owns the Simplify gizmo's target, worker preview, scene overlay, and one-step commit.
 *
 * Exactly one volume is simplified. A whole-object selection is accepted only when it resolves to
 * one volume; otherwise the user selects a part first. Results are staged as ordinary part imports,
 * preserving volume metadata and all four triangle-paint channels through the editor's existing
 * in-place volume-replacement seam. Linked copies are updated together because geometry is
 * object-level.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import * as THREE from 'three'
import {
  canonicalThreeMfPartSubtype,
  isNonRenderableThreeMfPartSubtype,
  type SceneEditPartSubtype
} from '@printstream/shared'
import { toast } from '../../lib/toast'
import {
  PAINT_CHANNEL_SPECS,
  RESTING_GIZMO_MODE,
  isAddedPartMesh,
  isViewportAidMesh,
  partGroupRef,
  type GizmoMode
} from './editorGeometry'
import {
  addedPartHostId,
  addedPartPaintKey,
  bodyPartSubtype,
  effectiveAddedParts,
  partSlotKey,
  replaceInstanceGeometry,
  supportPaintKey,
  type EditorAddedPart,
  type EditorInstance,
  type EditorState
} from './lib/editorModel'
import type { EditorImportStore } from './lib/editorImportStore'
import { triangleSoupToBinaryStl } from './lib/meshCut'
import { toObjectLocalSoup } from './lib/meshBooleanCore'
import { simplifyMesh } from './lib/meshSimplifyClient'
import {
  type SimplifyDetailLevel,
  type SimplifyMode,
  type SimplifyPaint,
  type SimplifyResult,
  type SimplifySettings
} from './lib/meshSimplify'
import type { PartMember, PartRef } from './lib/selectionModel'
import type { EditorPaint } from './useEditorPaint'

interface SimplifyTarget {
  host: EditorInstance
  hostId: number
  member: PartMember
  name: string
  soup: Float32Array
  paint: SimplifyPaint
  sourceMeshes: THREE.Mesh[]
  sourcePaintKey: string | null
  /** Selected mesh-local coordinates to the object's rotor-local coordinates. */
  sourceToObject: THREE.Matrix4
  rotor: THREE.Object3D
  subtype: SceneEditPartSubtype
  filamentId: number | null
  settings?: Record<string, string>
  addedTransform?: Pick<EditorAddedPart, 'position' | 'rotation' | 'scale'>
}

export interface EditorSimplifyParams {
  gizmoMode: GizmoMode
  setGizmoMode: (mode: GizmoMode) => void
  selectedKey: string | null
  extraSelectedKeys: ReadonlyArray<string>
  gizmoPart: PartRef | null
  activePlateIndex: number
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  setState: (updater: (current: EditorState | null) => EditorState | null) => void
  importStore: EditorImportStore
  paint: Pick<EditorPaint, 'effectivePaintCodes'>
  rotorOf: (group: THREE.Group) => THREE.Object3D
  nextInstanceKey: () => string
  recordHistoryRef: MutableRefObject<() => void>
  setSelectedKey: (key: string | null) => void
  setPartSelection: (selection: null) => void
  setGizmoPart: (part: PartRef | null) => void
  setAddedPartMeshVersion: (updater: (version: number) => number) => void
  setRebuildToken: (updater: (token: number) => number) => void
  regenerateActiveThumbnailRef: MutableRefObject<(() => void) | null>
  rebuildToken: number
  addedPartMeshVersion: number
}

export interface EditorSimplify {
  name: string
  sourceTriangles: number
  previewTriangles: number | null
  mode: SimplifyMode
  setMode: (mode: SimplifyMode) => void
  detail: SimplifyDetailLevel
  setDetail: (detail: SimplifyDetailLevel) => void
  ratio: number
  setRatio: (ratio: number) => void
  busy: boolean
  error: string | null
  apply: () => void
}

const CHANNELS = ['supports', 'seam', 'color', 'fuzzy'] as const

/** Collect actual volume geometry, including helpers that intentionally have no paint tag. */
export function collectSimplifyVolumeMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    // A helper volume is still a real selectable volume and may be simplified explicitly. Other
    // aids under the mesh (paint overlays, layer shading) must never enter the source soup.
    if (isViewportAidMesh(mesh) && !mesh.userData.isHelperVolume) return
    meshes.push(mesh)
  })
  return meshes
}

/** Preserve triangle order while moving exactly the selected meshes into world space. */
function worldTrianglesOf(meshes: readonly THREE.Mesh[]): Float32Array {
  const total = meshes.reduce((sum, mesh) => sum + (mesh.geometry.getIndex()?.count
    ?? mesh.geometry.getAttribute('position')?.count ?? 0) * 3, 0)
  const soup = new Float32Array(total)
  const point = new THREE.Vector3()
  let write = 0
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false)
    const position = mesh.geometry.getAttribute('position')
    if (!position) continue
    const index = mesh.geometry.getIndex()
    const count = index?.count ?? position.count
    for (let i = 0; i < count; i += 1) {
      point.fromBufferAttribute(position as THREE.BufferAttribute, index ? index.getX(i) : i)
        .applyMatrix4(mesh.matrixWorld)
      soup[write++] = point.x
      soup[write++] = point.y
      soup[write++] = point.z
    }
  }
  return write === soup.length ? soup : soup.slice(0, write)
}

/** Resolve the editor paint key carried by the target mesh. */
function paintKeyFor(mesh: THREE.Mesh): string | null {
  const ref = mesh.userData.supportPaintPart as
    | { objectId: number; componentObjectId: number }
    | { addedPartImportId: string }
    | undefined
  if (!ref) return null
  return 'addedPartImportId' in ref
    ? addedPartPaintKey(ref.addedPartImportId)
    : supportPaintKey(ref.objectId, ref.componentObjectId)
}

/** Find the scene node and meshes for one part identity. */
function nodeForMember(group: THREE.Group, member: PartMember): THREE.Object3D | null {
  if (member.kind === 'body') return group
  let found: THREE.Object3D | null = null
  group.traverse((node) => {
    if (found) return
    if (member.kind === 'added') {
      if (node.userData.addedPartKey === member.key) found = node
      return
    }
    const ref = partGroupRef(node)
    if (ref?.partIndex === member.partIndex) found = node
  })
  return found
}

/** Whether a mesh belongs to a baked/imported part rather than the object's unsplit body. */
function hasPartAncestor(mesh: THREE.Object3D, root: THREE.Object3D): boolean {
  let cursor: THREE.Object3D | null = mesh
  while (cursor && cursor !== root) {
    if (partGroupRef(cursor)) return true
    cursor = cursor.parent
  }
  return false
}

/** Infer which single volume a whole-object selection represents. */
function soleObjectMember(group: THREE.Group): PartMember | null {
  const candidates = collectSimplifyVolumeMeshes(group)
  if (candidates.length !== 1) return null
  const mesh = candidates[0]!
  const addedKey = typeof mesh.userData.addedPartKey === 'string'
    ? mesh.userData.addedPartKey
    : typeof mesh.parent?.userData.addedPartKey === 'string'
      ? mesh.parent.userData.addedPartKey
      : null
  if (addedKey) return { kind: 'added', key: addedKey }
  let cursor: THREE.Object3D | null = mesh
  while (cursor && cursor !== group) {
    const ref = partGroupRef(cursor)
    if (ref) return { kind: 'baked', partIndex: ref.partIndex }
    cursor = cursor.parent
  }
  return { kind: 'body' }
}

/** Write the replacement's complete paint state under its new geometry key. */
function withReplacementPaint(
  state: EditorState,
  key: string | null,
  paint: SimplifyPaint,
  previousKey?: string | null
): EditorState {
  if (!key) return state
  const next = { ...state }
  for (const channel of CHANNELS) {
    const stateKey = PAINT_CHANNEL_SPECS[channel].stateKey
    const entries = { ...(state[stateKey] ?? {}) }
    if (previousKey && previousKey !== key) delete entries[previousKey]
    entries[key] = { ...(paint[channel] ?? {}) }
    next[stateKey] = entries
  }
  return next
}

/** Build the object's printable local soup after substituting the simplify result for its source. */
function replacementPrintableSoup(target: SimplifyTarget, result: SimplifyResult): Float32Array {
  const replaced = new Set<THREE.Mesh>(target.sourceMeshes)
  const survivingMeshes: THREE.Mesh[] = []
  target.rotor.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || replaced.has(mesh) || isViewportAidMesh(mesh)) return
    survivingMeshes.push(mesh)
  })
  target.rotor.updateWorldMatrix(true, false)
  const inverse = new THREE.Matrix4().copy(target.rotor.matrixWorld).invert()
  const survivingSoup = toObjectLocalSoup(worldTrianglesOf(survivingMeshes), inverse)
  const includesResult = !isNonRenderableThreeMfPartSubtype(target.subtype)
  if (!includesResult) return survivingSoup

  const replacementSoup = toObjectLocalSoup(result.soup, target.sourceToObject)

  const combined = new Float32Array(survivingSoup.length + replacementSoup.length)
  combined.set(survivingSoup)
  combined.set(replacementSoup, survivingSoup.length)
  return combined
}

/** Apply BambuStudio's ensure-on-bed result to every linked placement of the edited object. */
export function restLinkedInstancesOnBed(
  state: EditorState,
  hostId: number,
  printableSoup: Float32Array
): EditorState {
  if (printableSoup.length === 0) return state
  return {
    ...state,
    plates: state.plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) => {
        if (addedPartHostId(instance) !== hostId) return instance
        const basis = instance.exactMatrix
          ? new THREE.Matrix4().set(
            instance.exactMatrix[0]!, instance.exactMatrix[3]!, instance.exactMatrix[6]!, 0,
            instance.exactMatrix[1]!, instance.exactMatrix[4]!, instance.exactMatrix[7]!, 0,
            instance.exactMatrix[2]!, instance.exactMatrix[5]!, instance.exactMatrix[8]!, 0,
            0, 0, 0, 1
          )
          : new THREE.Matrix4()
            .makeScale(instance.scale.x, instance.scale.y, instance.scale.z)
            .multiply(new THREE.Matrix4().makeRotationFromEuler(instance.rotation))
        const point = new THREE.Vector3()
        let minZ = Number.POSITIVE_INFINITY
        for (let offset = 0; offset < printableSoup.length; offset += 3) {
          point.set(
            printableSoup[offset]!,
            printableSoup[offset + 1]!,
            printableSoup[offset + 2]!
          ).applyMatrix4(basis)
          minZ = Math.min(minZ, point.z)
        }
        const position = instance.position.clone()
        position.z = minZ === 0 ? 0 : -minZ
        if (!instance.exactMatrix) return { ...instance, position }
        const exactMatrix = [...instance.exactMatrix]
        exactMatrix[11] = position.z
        return { ...instance, position, exactMatrix }
      })
    }))
  }
}

/** Revalidate the volume after worker and upload awaits before applying destructive state. */
function targetStillExists(state: EditorState, host: EditorInstance, member: PartMember): boolean {
  if (member.kind === 'body') return !host.bodyRemoved && host.parts.length === 0
  if (member.kind === 'baked') {
    return host.parts.some((part) => part.partIndex === member.partIndex)
  }
  return effectiveAddedParts(state, host).some((part) => part.key === member.key)
}

export function useEditorSimplify(params: EditorSimplifyParams): EditorSimplify {
  const {
    gizmoMode,
    setGizmoMode,
    selectedKey,
    extraSelectedKeys,
    gizmoPart,
    activePlateIndex,
    stateRef,
    groupByKeyRef,
    setState,
    importStore,
    paint,
    rotorOf,
    nextInstanceKey,
    recordHistoryRef,
    setSelectedKey,
    setPartSelection,
    setGizmoPart,
    setAddedPartMeshVersion,
    setRebuildToken,
    regenerateActiveThumbnailRef,
    rebuildToken,
    addedPartMeshVersion
  } = params
  const effectivePaintCodes = paint.effectivePaintCodes
  const [mode, setMode] = useState<SimplifyMode>('detail')
  const [detail, setDetail] = useState<SimplifyDetailLevel>('medium')
  const [ratio, setRatio] = useState(50)
  const [target, setTarget] = useState<SimplifyTarget | null>(null)
  const [preview, setPreview] = useState<SimplifyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previewRef = useRef<SimplifyResult | null>(null)
  previewRef.current = preview

  // Capture the source once per target/rebuild. Slider changes only re-run the worker, not the
  // expensive scene traversal and world-to-object conversion.
  useEffect(() => {
    if (gizmoMode !== 'simplify' || !selectedKey) {
      setTarget(null)
      setPreview(null)
      setBusy(false)
      setError(null)
      return
    }
    if (extraSelectedKeys.length > 0) {
      setBusy(false)
      setTarget(null)
      setError('Select exactly one volume to simplify.')
      return
    }
    const state = stateRef.current
    const plate = state?.plates.find((entry) => entry.index === activePlateIndex)
    const host = plate?.instances.find((entry) => entry.key === selectedKey)
    const group = groupByKeyRef.current.get(selectedKey)
    if (!state || !host || !group) {
      setBusy(false)
      setTarget(null)
      setError('The selected volume is still loading.')
      return
    }
    const hostId = addedPartHostId(host)
    if (hostId == null) {
      setBusy(false)
      setError('This volume has no editable object identity.')
      setTarget(null)
      return
    }
    const member = gizmoPart && gizmoPart.objectId === hostId
      ? gizmoPart.member
      : soleObjectMember(group)
    if (!member) {
      setBusy(false)
      setError('Select one part of this multi-volume object to simplify.')
      setTarget(null)
      return
    }
    const node = nodeForMember(group, member)
    if (!node) {
      setBusy(false)
      setError('The selected volume is still loading.')
      setTarget(null)
      return
    }
    let meshes = collectSimplifyVolumeMeshes(node)
    if (member.kind === 'body') {
      meshes = meshes.filter((mesh) => !isAddedPartMesh(mesh) && !hasPartAncestor(mesh, group))
    }
    if (meshes.length !== 1) {
      setBusy(false)
      setError('Select exactly one mesh volume to simplify.')
      setTarget(null)
      return
    }
    const sourceMesh = meshes[0]!
    const sourcePaintKey = paintKeyFor(sourceMesh)
    const rotor = rotorOf(group)
    rotor.updateWorldMatrix(true, false)
    sourceMesh.updateWorldMatrix(true, false)
    const soup = toObjectLocalSoup(
      worldTrianglesOf(meshes),
      new THREE.Matrix4().copy(sourceMesh.matrixWorld).invert()
    )
    const sourceToObject = new THREE.Matrix4()
      .copy(rotor.matrixWorld)
      .invert()
      .multiply(sourceMesh.matrixWorld)
    const paintMaps: SimplifyPaint = {}
    if (sourcePaintKey) {
      for (const channel of CHANNELS) {
        const codes = effectivePaintCodes(sourceMesh, channel)
        if (codes) paintMaps[channel] = { ...codes }
      }
    }
    const baked = member.kind === 'baked'
      ? host.parts.find((entry) => entry.partIndex === member.partIndex)
      : null
    const added = member.kind === 'added'
      ? effectiveAddedParts(state, host).find((entry) => entry.key === member.key)
      : null
    const subtype = member.kind === 'body'
      ? bodyPartSubtype(state, host)
      : member.kind === 'added'
        ? added?.subtype ?? 'normal_part'
        : canonicalThreeMfPartSubtype(baked?.subtype)
    const settings = member.kind === 'added'
      ? added?.settings
      : state.partProcessOverrides?.[partSlotKey(hostId, member.kind === 'baked' ? member.partIndex : 0)]
    setError(null)
    setTarget({
      host,
      hostId,
      member,
      name: member.kind === 'added' ? added?.name ?? host.name : baked?.name ?? host.name,
      soup,
      paint: paintMaps,
      sourceMeshes: meshes,
      sourcePaintKey,
      sourceToObject,
      rotor,
      subtype,
      filamentId: member.kind === 'added' ? added?.filamentId ?? null : baked?.filamentId ?? host.filamentId,
      ...(settings ? { settings: { ...settings } } : {}),
      ...(added
        ? {
            addedTransform: {
              position: added.position.clone(),
              rotation: added.rotation.clone(),
              scale: added.scale.clone()
            }
          }
        : {})
    })
    // The target's defaults restart as Studio's do when a new volume is selected.
    setMode('detail')
    setDetail('medium')
    setRatio(50)
    setPreview(null)
  }, [gizmoMode, selectedKey, extraSelectedKeys, gizmoPart, activePlateIndex, rebuildToken, addedPartMeshVersion,
    groupByKeyRef, effectivePaintCodes, rotorOf, stateRef])

  // Debounce slider movement, and terminate obsolete workers rather than letting old previews queue.
  useEffect(() => {
    if (gizmoMode !== 'simplify' || !target) return undefined
    const controller = new AbortController()
    const settings: SimplifySettings = { mode, detail, ratio }
    setBusy(true)
    setError(null)
    setPreview(null)
    const timeout = window.setTimeout(() => {
      simplifyMesh(target.soup, target.paint, settings, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setPreview(result)
        })
        .catch((reason) => {
          if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
            setError(reason instanceof Error ? reason.message : 'Unable to simplify this volume.')
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false)
        })
    }, 150)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [gizmoMode, target, mode, detail, ratio])

  // Replace the selected mesh visually while the preview is current. It is an explicit viewport
  // aid, so every geometry collector ignores it and Apply can safely read the real source beneath.
  useEffect(() => {
    if (gizmoMode !== 'simplify' || !target || !preview) return undefined
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(preview.soup, 3))
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
    const sourceMaterial = target.sourceMeshes[0]?.material
    const material = (Array.isArray(sourceMaterial) ? sourceMaterial[0] : sourceMaterial)?.clone()
      ?? new THREE.MeshStandardMaterial({ color: 0x9aa5b1, roughness: 0.75 })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData.isSimplifyPreview = true
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(target.sourceToObject)
    const sourceVisibility = target.sourceMeshes.map((source) => source.visible)
    target.sourceMeshes.forEach((source) => { source.visible = false })
    target.rotor.add(mesh)
    return () => {
      target.rotor.remove(mesh)
      geometry.dispose()
      material.dispose()
      target.sourceMeshes.forEach((source, index) => { source.visible = sourceVisibility[index] ?? true })
    }
  }, [gizmoMode, target, preview])

  const apply = useCallback(async () => {
    const result = previewRef.current
    if (!target || !result || result.triangleCount >= target.soup.length / 9) return
    // Capture the post-edit footprint before staging: the scene can rebuild while that request is
    // in flight. It also provides the exact geometry needed for Studio's ensure-on-bed step.
    const printableSoup = replacementPrintableSoup(target, result)
    setBusy(true)
    try {
      const staged = await importStore.stageFile(new File(
        [triangleSoupToBinaryStl(result.soup)],
        `${target.name}.stl`,
        { type: 'application/octet-stream' }
      ), 'part')
      const current = stateRef.current
      if (!current) return
      const liveHost = current.plates.flatMap((plate) => plate.instances)
        .find((instance) => addedPartHostId(instance) === target.hostId)
      if (!liveHost) {
        toast.error('The volume being simplified is no longer in this project.')
        return
      }
      if (!targetStillExists(current, liveHost, target.member)) {
        toast.error('The volume being simplified changed before the result could be applied.')
        return
      }

      const addedPart: EditorAddedPart = {
        key: target.member.kind === 'added' ? target.member.key : nextInstanceKey(),
        importId: staged.importId,
        subtype: target.subtype,
        name: target.name,
        ...(target.filamentId != null ? { filamentId: target.filamentId } : {}),
        position: target.addedTransform?.position.clone() ?? new THREE.Vector3(),
        rotation: target.addedTransform?.rotation.clone() ?? new THREE.Euler(),
        scale: target.addedTransform?.scale.clone() ?? new THREE.Vector3(1, 1, 1),
        soup: result.soup,
        ...(target.settings ? { settings: { ...target.settings } } : {})
      }
      const newPaintKey = target.member.kind === 'body'
        ? supportPaintKey(target.hostId, 0)
        : target.member.kind === 'baked'
          ? target.sourcePaintKey
          : addedPartPaintKey(staged.importId)
      const targetMember = target.member
      const replacements = new Map<string, EditorInstance>()
      if (targetMember.kind === 'body') {
        for (const plate of current.plates) {
          for (const instance of plate.instances) {
            if (addedPartHostId(instance) !== target.hostId) continue
            const replacement = replaceInstanceGeometry(
              instance,
              staged,
              target.hostId,
              importStore.meshUrl,
              null
            )
            replacements.set(instance.key, instance.exactMatrix
              ? {
                  ...replacement,
                  position: instance.position.clone(),
                  exactMatrix: [...instance.exactMatrix]
                }
              : replacement)
          }
        }
      }

      const commit = (state: EditorState | null): EditorState | null => {
        if (!state) return state
        const commitHost = state.plates.flatMap((plate) => plate.instances)
          .find((instance) => addedPartHostId(instance) === target.hostId)
        if (!commitHost || !targetStillExists(state, commitHost, targetMember)) return state
        let next = state
        if (targetMember.kind === 'baked') {
          next = {
            ...state,
            partMeshReplacements: {
              ...(state.partMeshReplacements ?? {}),
              [partSlotKey(target.hostId, targetMember.partIndex)]: staged.importId
            }
          }
        } else if (targetMember.kind === 'added') {
          next = {
            ...state,
            addedParts: {
              ...(state.addedParts ?? {}),
              [target.hostId]: (state.addedParts?.[target.hostId] ?? [])
                .map((part) => part.key === targetMember.key ? addedPart : part)
            }
          }
        } else {
          next = {
            ...state,
            plates: state.plates.map((plate) => ({
              ...plate,
              instances: plate.instances.map((instance) => replacements.get(instance.key) ?? instance)
            }))
          }
        }
        next = restLinkedInstancesOnBed(next, target.hostId, printableSoup)
        return withReplacementPaint(next, newPaintKey, result.paint, target.sourcePaintKey)
      }

      recordHistoryRef.current?.()
      setState(commit)
      setPartSelection(null)
      if (targetMember.kind === 'body') {
        const replacement = replacements.get(target.host.key)
        setGizmoPart(null)
        if (replacement) setSelectedKey(replacement.key)
      } else {
        setGizmoPart({ objectId: target.hostId, member: targetMember })
      }
      setAddedPartMeshVersion((version) => version + 1)
      setRebuildToken((token) => token + 1)
      regenerateActiveThumbnailRef.current?.()
      setGizmoMode(RESTING_GIZMO_MODE)
      toast.success(`Simplified ${target.name} from ${(target.soup.length / 9).toLocaleString()} to ${result.triangleCount.toLocaleString()} triangles.`)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to simplify this volume.')
    } finally {
      setBusy(false)
    }
  }, [target, importStore, stateRef, nextInstanceKey, recordHistoryRef, setState, setPartSelection,
    setGizmoPart, setSelectedKey, setAddedPartMeshVersion, setRebuildToken,
    regenerateActiveThumbnailRef, setGizmoMode])

  return {
    name: target?.name ?? 'Selected volume',
    sourceTriangles: target ? target.soup.length / 9 : 0,
    previewTriangles: preview?.triangleCount ?? null,
    mode,
    setMode,
    detail,
    setDetail,
    ratio,
    setRatio,
    busy,
    error,
    apply
  }
}
