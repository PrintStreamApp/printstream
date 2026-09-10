/**
 * STL parsing, welding, merging, and serialization for staged imports.
 *
 * Shared because both surfaces import geometry: the api parses an uploaded STL, and the browser
 * parses one the user picked for the public editor, where nothing is uploaded. This module covers
 * STL only; a 3MF's geometry comes from `mesh-extract.ts` and a STEP's from `step-mesh.ts`, both
 * equally shared. Which formats a host actually offers is declared on its import store, not
 * inferred from here (`apps/web/src/plugins/model-studio/lib/editorImportStore.ts`).
 *
 * Byte-level work here takes `Uint8Array` and a `DataView`, not `Buffer`: Node's Buffer IS a
 * Uint8Array, so the api passes one straight through, while the browser has no Buffer at all.
 */
import { ModelImportError } from './imported-mesh.js'
import type { ImportedMesh, ImportedMeshBounds } from './imported-mesh.js'

/** A DataView over exactly this view's bytes, a Uint8Array may be a window onto a larger buffer. */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Ceiling for any staged import's merged triangle count (STL/STEP parse and 3MF extraction). */
export const MAX_IMPORT_TRIANGLES = 5_000_000

/**
 * Translate a staged import so its XY bounding-box centre sits at the origin and its lowest point
 * at z = 0, returning the offset removed. Mutates `mesh` (and every part) in place.
 *
 * WHY. An editor instance's `position` places its LOCAL ORIGIN, and the rotate gizmo attaches to a
 * rotor at that origin, so rotation happens about the origin. A file's own coordinates put that
 * origin wherever the exporter did (commonly a corner, or centred in XY with z running 0..height),
 * and the object then rotates about a corner or an edge instead of about itself. Placement code
 * compensates by offsetting `position` by the mesh centroid (`stagedFootprint`), which lands the
 * model correctly but leaves the ORIGIN, and therefore the pivot, displaced by exactly that
 * centroid.
 *
 * ONLY FOR A WHOLE OBJECT. An added PART is centred on every axis instead
 * (`primitivePartSoup`), because `addedPartDropPosition` places it by a single point relative to
 * its host: drop a helper volume at the host's centre and flooring its Z would bury it half its
 * height too high. So the caller states which it is staging (`ImportNormalization`); this is not a
 * blanket rule the store can apply on its own.
 *
 * The same normalisation two sibling paths already do: the cut/split/assemble paths rebase their
 * triangle soups (`rebaseTriangleSoup`, which states this same centre-XY/floor-Z convention), and a
 * 3MF import is centred during extraction (`recentreParts` in `mesh-extract.ts`). STL and STEP had
 * neither. Idempotent, so applying it after either sibling changes nothing.
 *
 * ONE offset for the whole import, taken from the MERGED mesh and applied to every part: parts
 * share the merged mesh's coordinate space, so rebasing each to its own centre would collapse a
 * multi-solid assembly onto itself.
 */
export function rebaseImportedMesh(mesh: ImportedMesh): { offset: { x: number; y: number; z: number } } {
  const { min, max } = mesh.bounds
  const offset = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: min.z }
  if (offset.x === 0 && offset.y === 0 && offset.z === 0) return { offset }
  const shift = (target: ImportedMesh): void => {
    for (let i = 0; i + 2 < target.positions.length; i += 3) {
      target.positions[i] = (target.positions[i] ?? 0) - offset.x
      target.positions[i + 1] = (target.positions[i + 1] ?? 0) - offset.y
      target.positions[i + 2] = (target.positions[i + 2] ?? 0) - offset.z
    }
    target.bounds = computeMeshBounds(target.positions)
  }
  shift(mesh)
  for (const part of mesh.parts ?? []) shift(part.mesh)
  return { offset }
}

/**
 * Weld exact-duplicate vertex positions into shared indexed vertices (dropping triangles
 * degenerate after the weld). STL is triangle soup by definition and OCCT tessellates each
 * BRep face independently, so without this every imported mesh reaches the 3MF as an
 * index-level soup, and BambuStudio's slicer chains layer contours by vertex/edge INDEX
 * (`chain_open_polylines_exact`), dumping a soup mesh entirely into its 2mm proximity
 * gap-closing heuristic. That mis-stitches small features: zero-clearance inlays (text
 * pockets) print fused/unfilled, looking like the wall generator is broken. Exact equality
 * is the right tolerance: duplicated corners are written from the same source floats.
 *
 * Every format that arrives as soup gets this, not just STL: OBJ and glTF index their own
 * vertices but routinely repeat a position per smoothing group or per UV seam, and an AMF's
 * per-volume vertex lists are independent of each other.
 */
export function weldImportedMeshVertices(mesh: ImportedMesh): ImportedMesh {
  const vertexCount = Math.floor(mesh.positions.length / 3)
  const keyToIndex = new Map<string, number>()
  const remap = new Uint32Array(vertexCount)
  const positions: number[] = []
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const x = mesh.positions[vertex * 3] ?? 0
    const y = mesh.positions[vertex * 3 + 1] ?? 0
    const z = mesh.positions[vertex * 3 + 2] ?? 0
    const key = `${x},${y},${z}`
    let index = keyToIndex.get(key)
    if (index == null) {
      index = positions.length / 3
      keyToIndex.set(key, index)
      positions.push(x, y, z)
    }
    remap[vertex] = index
  }
  if (positions.length === mesh.positions.length) return mesh
  const indices: number[] = []
  for (let triangle = 0; triangle + 2 < mesh.indices.length; triangle += 3) {
    const a = remap[mesh.indices[triangle] ?? 0] ?? 0
    const b = remap[mesh.indices[triangle + 1] ?? 0] ?? 0
    const c = remap[mesh.indices[triangle + 2] ?? 0] ?? 0
    if (a === b || b === c || c === a) continue
    indices.push(a, b, c)
  }
  return { ...mesh, positions, indices }
}

/**
 * Reject a mesh whose triangle count exceeds the import budget. The STL parsers
 * cap their input directly; STEP is tessellated by OCCT (WASM) with no inherent
 * output bound, so its produced triangle count must be checked here before the
 * JS-side positions/indices amplification, otherwise a small STEP file can
 * tessellate into a multi-gigabyte mesh and exhaust the process (an authenticated
 * memory-exhaustion vector via /imports and /:id/mesh).
 *
 * The same applies to every format whose triangle count is not stated in a header the
 * parser can check up front: OBJ and AMF are counted as they are read, and a glTF's
 * accessor counts are attacker-supplied, so each calls this before amplifying.
 */
export function assertImportTriangleBudget(triangleCount: number): void {
  if (triangleCount > MAX_IMPORT_TRIANGLES) {
    throw new ModelImportError('Model is too large to import')
  }
}

export function parseStlMesh(bytes: Uint8Array): ImportedMesh {
  const mesh = isBinaryStl(bytes) ? parseBinaryStl(bytes) : parseAsciiStl(bytes)
  if (mesh.indices.length === 0) throw new ModelImportError('STL contained no triangles')
  return weldImportedMeshVertices(mesh)
}

/**
 * Binary STL detection: a binary file is 84 + 50*triangles bytes. ASCII STLs start with "solid" but
 * so can binary headers, so the size check is the reliable discriminator.
 */
function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false
  const triangles = viewOf(bytes).getUint32(80, true)
  return bytes.length === 84 + triangles * 50
}

function parseBinaryStl(bytes: Uint8Array): ImportedMesh {
  const view = viewOf(bytes)
  const triangles = view.getUint32(80, true)
  if (triangles > MAX_IMPORT_TRIANGLES) throw new ModelImportError('STL is too large to import')
  const positions: number[] = []
  const indices: number[] = []
  const accumulator = new BoundsAccumulator()
  let offset = 84
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    offset += 12 // skip the per-facet normal
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const x = view.getFloat32(offset, true)
      const y = view.getFloat32(offset + 4, true)
      const z = view.getFloat32(offset + 8, true)
      offset += 12
      indices.push(positions.length / 3)
      positions.push(x, y, z)
      accumulator.add(x, y, z)
    }
    offset += 2 // attribute byte count
  }
  return { positions, indices, bounds: accumulator.bounds() }
}

function parseAsciiStl(bytes: Uint8Array): ImportedMesh {
  const positions: number[] = []
  const indices: number[] = []
  const accumulator = new BoundsAccumulator()
  const vertexPattern = /vertex\s+(-?[0-9eE.+-]+)\s+(-?[0-9eE.+-]+)\s+(-?[0-9eE.+-]+)/g
  const text = new TextDecoder().decode(bytes)
  let match: RegExpExecArray | null
  while ((match = vertexPattern.exec(text)) !== null) {
    const x = Number.parseFloat(match[1] ?? '')
    const y = Number.parseFloat(match[2] ?? '')
    const z = Number.parseFloat(match[3] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    indices.push(positions.length / 3)
    positions.push(x, y, z)
    accumulator.add(x, y, z)
    if (indices.length > MAX_IMPORT_TRIANGLES * 3) throw new ModelImportError('STL is too large to import')
  }
  if (positions.length % 9 !== 0) {
    // Drop a trailing partial triangle rather than emitting a malformed mesh.
    const usableVertices = Math.floor(positions.length / 9) * 9
    positions.length = usableVertices
    indices.length = usableVertices / 3
  }
  return { positions, indices, bounds: accumulator.bounds() }
}


export function mergeImportedMeshes(meshes: ImportedMesh[]): ImportedMesh {
  const positions: number[] = []
  const indices: number[] = []
  const accumulator = new BoundsAccumulator()
  for (const mesh of meshes) {
    const base = positions.length / 3
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0
      const y = mesh.positions[i + 1] ?? 0
      const z = mesh.positions[i + 2] ?? 0
      positions.push(x, y, z)
      accumulator.add(x, y, z)
    }
    for (const index of mesh.indices) indices.push(base + index)
  }
  return { positions, indices, bounds: accumulator.bounds() }
}


/** Serialize a mesh to a binary STL so the editor can render staged imports with its STL loader. */
export function meshToBinaryStl(mesh: ImportedMesh): Uint8Array {
  const triangleCount = Math.floor(mesh.indices.length / 3)
  const bytes = new Uint8Array(84 + triangleCount * 50)
  const view = viewOf(bytes)
  view.setUint32(80, triangleCount, true)
  let offset = 84
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    offset += 12 // zeroed facet normal; slicers recompute from winding
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const base = (mesh.indices[triangle * 3 + vertex] ?? 0) * 3
      view.setFloat32(offset, mesh.positions[base] ?? 0, true)
      view.setFloat32(offset + 4, mesh.positions[base + 1] ?? 0, true)
      view.setFloat32(offset + 8, mesh.positions[base + 2] ?? 0, true)
      offset += 12
    }
    offset += 2 // attribute byte count
  }
  return bytes
}


/** Axis-aligned bounds of a flat positions array (3 floats per vertex). */
export function computeMeshBounds(positions: ReadonlyArray<number>): ImportedMeshBounds {
  const accumulator = new BoundsAccumulator()
  for (let i = 0; i < positions.length; i += 3) {
    accumulator.add(positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0)
  }
  return accumulator.bounds()
}

class BoundsAccumulator {
  private minX = Infinity
  private minY = Infinity
  private minZ = Infinity
  private maxX = -Infinity
  private maxY = -Infinity
  private maxZ = -Infinity

  add(x: number, y: number, z: number): void {
    if (x < this.minX) this.minX = x
    if (y < this.minY) this.minY = y
    if (z < this.minZ) this.minZ = z
    if (x > this.maxX) this.maxX = x
    if (y > this.maxY) this.maxY = y
    if (z > this.maxZ) this.maxZ = z
  }

  bounds(): ImportedMeshBounds {
    if (!Number.isFinite(this.minX)) {
      return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
    }
    return {
      min: { x: this.minX, y: this.minY, z: this.minZ },
      max: { x: this.maxX, y: this.maxY, z: this.maxZ }
    }
  }
}
