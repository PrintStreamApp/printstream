/**
 * Recolours mounted editor meshes after a material assignment changes without rebuilding geometry.
 * Added volumes own their material independently of their host object; helper volumes keep their
 * tool colour. The same part inheritance rule used by the scene builder applies here.
 */
import * as THREE from 'three'
import { threeMfPartSubtypeCarriesFilament } from '@printstream/shared'
import { effectivePartFilamentId, type EditorInstance, type EditorState } from './editorModel'

type RecolourTag = { filamentId: number | null; fallbackColor?: string }

/** Find a render tag on this mesh or its nearest parent part. */
function ancestorTag<T>(mesh: THREE.Object3D, name: string): T | undefined {
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
    const tag = node.userData[name] as T | undefined
    if (tag !== undefined) return tag
  }
  return undefined
}

/** Apply one resolved filament colour and invalidate its paint overlay's cached tint. */
function recolourMesh(mesh: THREE.Mesh, tag: RecolourTag, filamentId: number | null, colors: Record<number, string>): void {
  tag.filamentId = filamentId
  const hex = (filamentId != null ? colors[filamentId] : undefined) || tag.fallbackColor || '#D3DDE7'
  const material = mesh.material as THREE.MeshStandardMaterial
  material.color.set(hex)
  if (material.emissive) material.emissive.set(hex).multiplyScalar(0.12)
  mesh.userData['paintOverlayCache:color'] = undefined
}

/**
 * Mutate the live groups in place after a filament reassignment. Missing groups are ignored while
 * an asynchronous plate build is in flight; the completed build runs this sync again.
 */
export function syncEditorMaterialScene(
  state: EditorState,
  groups: ReadonlyMap<string, THREE.Group>,
  resolveFilamentId: (id: number | null) => number | null,
  colors: Record<number, string>
): void {
  const byKey = new Map<string, EditorInstance>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) byKey.set(instance.key, instance)
  }
  const addedByKey = new Map(Object.values(state.addedParts ?? {}).flat().map((part) => [part.key, part]))

  for (const [key, group] of groups) {
    const instance = byKey.get(key)
    if (!instance) continue

    group.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      const tag = mesh.userData.recolor as RecolourTag | undefined
      if (!tag) return

      const addedKey = ancestorTag<string>(mesh, 'addedPartKey')
      if (addedKey) {
        const added = addedByKey.get(addedKey)
        // Tool volumes print no filament, so their diagnostic colour must survive a reassignment.
        if (!added || !threeMfPartSubtypeCarriesFilament(added.subtype)) return
        recolourMesh(mesh, tag, resolveFilamentId(added.filamentId ?? instance.filamentId), colors)
        return
      }

      let partRef: { partIndex: number } | undefined
      for (let parent: THREE.Object3D | null = mesh; parent && !partRef; parent = parent.parent) {
        partRef = (parent.userData.partRef ?? parent.userData.importPartRef) as { partIndex: number } | undefined
      }
      const part = partRef ? instance.parts.find((entry) => entry.partIndex === partRef.partIndex) : undefined
      const filamentId = part ? effectivePartFilamentId(part, instance.filamentId) : instance.filamentId
      recolourMesh(mesh, tag, resolveFilamentId(filamentId), colors)
    })
  }
}
