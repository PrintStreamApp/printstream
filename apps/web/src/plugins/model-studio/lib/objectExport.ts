/**
 * Object -> STL export (the context menu's "Export as STL", mirroring BambuStudio's
 * per-object "Export as one STL"). The object's model parts are merged from its live
 * render group, so baked part matrices and the instance's world placement (rotation,
 * scale, mirror) are already applied; the merged soup is then re-centred on the origin
 * with its bottom on Z=0: matching BambuStudio's align-to-origin and how this editor
 * places re-imported meshes.
 *
 * Negative parts, modifiers, and support blockers/enforcers are excluded: their meshes
 * are tagged `isHelperVolume` and skipped by `collectWorldTriangles`, and without a mesh
 * boolean pass exporting a negative volume as solid geometry would be wrong
 * (BambuStudio's no-boolean export path drops them the same way). Callers can detect
 * that via `groupHasExcludedVolumes` and tell the user.
 *
 * Also covers the other BambuStudio export shapes: several objects merged into one STL
 * (`buildObjectsStl`, the multi-selection "Export as one STL") and specific parts of one
 * object (`buildSelectedPartsStl`, the part menu's export, which DOES include a selected helper
 * volume, since picking it is explicit).
 */
import type * as THREE from 'three'
import { isAddedPartMesh } from '../editorGeometry'
import { collectWorldTriangles, rebaseTriangleSoup, triangleSoupToBinaryStl } from './meshCut'
import type { PartMember } from './selectionModel'

/**
 * Sanitized file base name (no extension) for an exported object: path separators and
 * other characters that are unsafe in filenames collapse to spaces, and an empty
 * result falls back to `'object'`. A trailing `.stl` the object name already carries
 * is folded away so the final name never doubles the extension.
 */
export function stlExportBaseName(objectName: string): string {
  const base = objectName
    .replace(/\.stl$/i, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return base || 'object'
}

/** Full `<sanitized name>.stl` filename for an exported object. */
export function stlExportFileName(objectName: string): string {
  return `${stlExportBaseName(objectName)}.stl`
}

/** Concatenate triangle soups into one buffer. */
function concatSoups(soups: ReadonlyArray<Float32Array>): Float32Array {
  const total = soups.reduce((sum, soup) => sum + soup.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const soup of soups) { out.set(soup, offset); offset += soup.length }
  return out
}

/**
 * Serialize one object's render group as binary STL (world transforms baked,
 * re-centred to origin, bottom on the bed plane). Returns null when the group
 * holds no solid geometry: e.g. an object whose every part is a modifier.
 */
export function buildObjectStl(group: THREE.Object3D): ArrayBuffer | null {
  return buildObjectsStl([group])
}

/**
 * Serialize several objects' render groups merged into ONE binary STL (the
 * multi-selection "Export as one STL"). The objects keep their relative world
 * placement; the merged result is re-centred as a whole. Returns null when no
 * group holds solid geometry.
 */
export function buildObjectsStl(groups: ReadonlyArray<THREE.Object3D>): ArrayBuffer | null {
  const soups = groups.map((group) => collectWorldTriangles(group)).filter((soup) => soup.length > 0)
  if (soups.length === 0) return null
  const soup = concatSoups(soups)
  rebaseTriangleSoup(soup)
  return triangleSoupToBinaryStl(soup)
}

/**
 * Serialize specific PARTS of one object's render group as one binary STL. Parts are
 * matched by the render tags carried on part groups: `partRef` (baked in-project
 * parts) or `importPartRef` (solids of a multi-solid import, e.g. a STEP assembly),
 * against the part-selection's ORDINAL (`partIndex`) key space. Unlike the whole-object
 * export, a selected helper volume (negative/modifier/blocker/enforcer part) IS
 * exported: picking the part is the deliberate ask for that volume's mesh.
 */
export function buildSelectedPartsStl(
  group: THREE.Object3D,
  members: ReadonlyArray<PartMember>
): ArrayBuffer | null {
  const bakedIndexes = new Set(members.flatMap((m) => (m.kind === 'baked' ? [m.partIndex] : [])))
  const addedKeys = new Set(members.flatMap((m) => (m.kind === 'added' ? [m.key] : [])))
  const wantsBody = members.some((m) => m.kind === 'body')
  // Only the TAG differs between the kinds: a volume added this session carries its own key, a
  // baked part carries the ordinal ref its part group was stamped with. Export used to be the one
  // part action added volumes could not do, which read as a rule about them ("they have no baked
  // mesh entry") but was really just this lookup -- the mesh is in the scene graph like any other,
  // and everything here works off world triangles, in the browser. One predicate over one traversal
  // is also what lets a MIXED selection export as a single STL.
  return buildMatchingPartsStl(group, (node) => {
    const addedKey = node.userData.addedPartKey
    if (typeof addedKey === 'string') return addedKeys.has(addedKey)
    const ref = (node.userData.partRef ?? node.userData.importPartRef) as { partIndex: number } | undefined
    if (ref != null) return bakedIndexes.has(ref.partIndex)
    // Neither tag: the object's own geometry, which is what the BODY member names. Only reachable
    // on an object with no part list, since one with parts tags every mesh it owns.
    return wantsBody && (node as THREE.Mesh).isMesh === true && !isAddedPartMesh(node)
  })
}

/** Shared traversal: world-bake every accepted node's triangles, then rebase the result. */
function buildMatchingPartsStl(
  group: THREE.Object3D,
  matches: (node: THREE.Object3D) => boolean
): ArrayBuffer | null {
  const soups: Float32Array[] = []
  group.updateWorldMatrix(true, true)
  group.traverse((node) => {
    if (!matches(node)) return
    const soup = collectWorldTriangles(node, { includeModifierVolumes: true })
    if (soup.length > 0) soups.push(soup)
  })
  if (soups.length === 0) return null
  const soup = concatSoups(soups)
  rebaseTriangleSoup(soup)
  return triangleSoupToBinaryStl(soup)
}

/**
 * Display name for a parts export: the part's own name for a single part (falling back
 * to "<object> part"), "<object> parts" for several. Shared by the export handler and
 * the destination dialog's suggested-name field so both agree.
 */
export function partsExportName(
  instance: { name: string; parts: ReadonlyArray<{ partIndex: number; name: string | null }> },
  members: ReadonlyArray<PartMember>,
  /** The host's session-added volumes, so a volume export is named after the volume too. */
  addedParts: ReadonlyArray<{ key: string; name: string }> = []
): string {
  if (members.length !== 1) return `${instance.name} parts`
  const only = members[0]!
  const name = only.kind === 'baked'
    ? instance.parts.find((entry) => entry.partIndex === only.partIndex)?.name
    : only.kind === 'added'
      ? addedParts.find((entry) => entry.key === only.key)?.name
      // The body carries the object's own name, which is the only name it has.
      : instance.name
  return name || `${instance.name} part`
}

/**
 * True when the group contains non-printed helper volumes (negative parts, modifiers,
 * support blockers/enforcers) that `buildObjectStl` leaves out of the export.
 */
export function groupHasExcludedVolumes(group: THREE.Object3D): boolean {
  let found = false
  group.traverse((node) => {
    if ((node as THREE.Mesh).isMesh && node.userData.isHelperVolume) found = true
  })
  return found
}
