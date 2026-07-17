/**
 * Object -> STL export (the context menu's "Export as STL", mirroring BambuStudio's
 * per-object "Export as one STL"). The object's model parts are merged from its live
 * render group, so baked part matrices and the instance's world placement (rotation,
 * scale, mirror) are already applied; the merged soup is then re-centred on the origin
 * with its bottom on Z=0 — matching BambuStudio's align-to-origin and how this editor
 * places re-imported meshes.
 *
 * Negative parts, modifiers, and support blockers/enforcers are excluded: their meshes
 * are tagged `isModifier` and skipped by `collectWorldTriangles`, and without a mesh
 * boolean pass exporting a negative volume as solid geometry would be wrong
 * (BambuStudio's no-boolean export path drops them the same way). Callers can detect
 * that via `groupHasExcludedVolumes` and tell the user.
 *
 * Also covers the other BambuStudio export shapes: several objects merged into one STL
 * (`buildObjectsStl`, the multi-selection "Export as one STL") and specific parts of one
 * object (`buildPartsStl`, the part menu's export — which DOES include a selected helper
 * volume, since picking it is explicit).
 */
import type * as THREE from 'three'
import { collectWorldTriangles, rebaseTriangleSoup, triangleSoupToBinaryStl } from './meshCut'

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
 * holds no solid geometry — e.g. an object whose every part is a modifier.
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
 * matched by the render tags carried on part groups — `partRef` (baked in-project
 * parts) or `importPartRef` (solids of a multi-solid import, e.g. a STEP assembly) —
 * against the part-selection's `componentObjectId` key space. Unlike the whole-object
 * export, a selected helper volume (negative/modifier/blocker/enforcer part) IS
 * exported: picking the part is the deliberate ask for that volume's mesh.
 */
export function buildPartsStl(
  group: THREE.Object3D,
  componentObjectIds: ReadonlyArray<number>
): ArrayBuffer | null {
  const wanted = new Set(componentObjectIds)
  const soups: Float32Array[] = []
  group.updateWorldMatrix(true, true)
  group.traverse((node) => {
    const ref = (node.userData.partRef ?? node.userData.importPartRef) as { componentObjectId: number } | undefined
    if (!ref || !wanted.has(ref.componentObjectId)) return
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
  instance: { name: string; parts: ReadonlyArray<{ componentObjectId: number; name: string | null }> },
  componentObjectIds: ReadonlyArray<number>
): string {
  if (componentObjectIds.length === 1) {
    const part = instance.parts.find((entry) => entry.componentObjectId === componentObjectIds[0])
    return part?.name || `${instance.name} part`
  }
  return `${instance.name} parts`
}

/**
 * True when the group contains non-printed helper volumes (negative parts, modifiers,
 * support blockers/enforcers) that `buildObjectStl` leaves out of the export.
 */
export function groupHasExcludedVolumes(group: THREE.Object3D): boolean {
  let found = false
  group.traverse((node) => {
    if ((node as THREE.Mesh).isMesh && node.userData.isModifier) found = true
  })
  return found
}
