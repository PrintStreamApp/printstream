/**
 * The addable part volumes and where their geometry comes from — BambuStudio's "Add part / Add
 * negative part / Add modifier / Add support blocker / Add support enforcer", each of which can be
 * a built-in primitive or a loaded mesh.
 *
 * Owns two things the editor would otherwise spread across the context menu and `EditorView`:
 * the menu's subtype ORDER and labels (a normal part is called "Part", not a helper volume — its
 * name and colour do not come from `helperVolumes.ts`), and the staging of a new part's mesh into
 * an `importId` + a client-render triangle soup, whatever the source.
 *
 * Every source ends up in the SAME place: a staged import, rendered locally from the returned soup
 * and baked server-side by `SceneEdit.addedParts` (`three-mf-scene-builder.applyAddedParts`). No
 * source gets its own endpoint.
 */
import * as THREE from 'three'
import type { SceneEditPartSubtype } from '@printstream/shared'
import { fetchImportMesh, stageImportFromFile, stageImportFromLibrary } from './editorImports'
import { HELPER_VOLUME_SPECS } from './helperVolumes'
import { parseStlGeometryAsync } from './meshParseClient'
import { primitivePartSoup, type PrimitiveKind } from './primitives'
import { triangleSoupToBinaryStl } from './meshCut'

/**
 * The subtypes the "Add …" menu offers, in BambuStudio's order (`ADD_VOLUME_MENU_ITEMS` in
 * `src/slic3r/GUI/GUI_Factories.cpp`) — a normal part first, then the helper volumes.
 */
export const ADDED_PART_SUBTYPES: SceneEditPartSubtype[] = [
  'normal_part',
  'negative_part',
  'modifier_part',
  'support_blocker',
  'support_enforcer'
]

/** Display label for an addable subtype. Helper volumes defer to their one spec table. */
export function addedPartLabel(subtype: SceneEditPartSubtype): string {
  return subtype === 'normal_part' ? 'Part' : HELPER_VOLUME_SPECS[subtype].label
}

/**
 * Where a new part's geometry comes from. `primitive` is generated on the client and uploaded;
 * the other two stage an existing model and read its mesh back, which is BambuStudio's "Load…"
 * (extended with the library, since our models usually live there rather than on the PC).
 */
export type AddedPartSource =
  | { kind: 'primitive'; shape: PrimitiveKind }
  | { kind: 'file'; file: File }
  | { kind: 'library'; libraryFileId: string }

export interface StagedAddedPartGeometry {
  /** The staged import carrying this part's mesh to the bake (`SceneEdit.addedParts.meshImportId`). */
  importId: string
  /** Client render geometry: non-indexed triangle soup, centred on the origin (9 floats/tri). */
  soup: Float32Array
  /** Suggested part name — the primitive's label, or the loaded model's file name. */
  name: string
}

/** Shift a soup in place so its bounding box is centred on the origin. */
function centerSoup(soup: Float32Array): void {
  if (soup.length === 0) return
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < soup.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = soup[i + axis]!
      if (value < min[axis]!) min[axis] = value
      if (value > max[axis]!) max[axis] = value
    }
  }
  const center = [0, 1, 2].map((axis) => (min[axis]! + max[axis]!) / 2)
  for (let i = 0; i < soup.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) soup[i + axis] = soup[i + axis]! - center[axis]!
  }
}

/** Read a staged import's mesh back as an origin-centred triangle soup for local rendering. */
async function soupFromStagedImport(importId: string, signal?: AbortSignal): Promise<Float32Array> {
  const buffer = await fetchImportMesh(importId, undefined, signal)
  const geometry = await parseStlGeometryAsync(new Uint8Array(buffer))
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry
  const positions = nonIndexed.getAttribute('position')
  const soup = new Float32Array(positions.array.length)
  soup.set(positions.array as Float32Array)
  if (nonIndexed !== geometry) nonIndexed.dispose()
  geometry.dispose()
  centerSoup(soup)
  return soup
}

/**
 * Stage a new part's geometry, whatever its source, as an import id + a soup to render locally.
 *
 * `size` is the target largest dimension (mm) for a generated primitive and is ignored for a
 * loaded model, which keeps its own real-world size — scaling someone's mesh to fit would silently
 * change the dimensions they modelled, and the gizmo is right there if they want it smaller.
 */
export async function stageAddedPartGeometry(
  source: AddedPartSource,
  size: number,
  signal?: AbortSignal
): Promise<StagedAddedPartGeometry> {
  if (source.kind === 'primitive') {
    const soup = primitivePartSoup(source.shape, size)
    const stl = triangleSoupToBinaryStl(soup)
    const staged = await stageImportFromFile(
      new File([stl], `${source.shape}.stl`, { type: 'application/octet-stream' }),
      signal
    )
    return { importId: staged.importId, soup, name: staged.name }
  }
  const staged = source.kind === 'file'
    ? await stageImportFromFile(source.file, signal)
    : await stageImportFromLibrary(source.libraryFileId, undefined, signal)
  return { importId: staged.importId, soup: await soupFromStagedImport(staged.importId, signal), name: staged.name }
}

/**
 * Where a new part is dropped inside its host, in the host's OBJECT-LOCAL space.
 *
 * Helper volumes land at the host's centre: a support blocker or modifier is meant to sit INSIDE
 * the geometry it acts on, and it renders translucent so it stays visible there. A normal part is
 * opaque printed geometry, so it lands beside the host instead — at the right-front-bottom corner
 * of its bounding box, like BambuStudio (`ObjectList::load_generic_subobject`) — where it is
 * visible and grabbable rather than buried.
 */
export function addedPartDropPosition(
  subtype: SceneEditPartSubtype,
  hostBox: THREE.Box3,
  partSize: THREE.Vector3,
  toObjectLocal: (point: THREE.Vector3) => THREE.Vector3
): THREE.Vector3 {
  if (hostBox.isEmpty()) return new THREE.Vector3()
  if (subtype !== 'normal_part') return toObjectLocal(hostBox.getCenter(new THREE.Vector3()))
  const corner = new THREE.Vector3(hostBox.max.x, hostBox.min.y, hostBox.min.z)
  return toObjectLocal(corner).add(partSize.clone().multiplyScalar(0.5))
}

/** The size of an origin-centred soup's bounding box. */
export function soupSize(soup: Float32Array): THREE.Vector3 {
  const box = new THREE.Box3()
  const point = new THREE.Vector3()
  for (let i = 0; i < soup.length; i += 3) {
    box.expandByPoint(point.set(soup[i]!, soup[i + 1]!, soup[i + 2]!))
  }
  return box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3())
}
