/**
 * Foreign-geometry import: parse STL and tessellate STEP into a plain triangle mesh that the 3MF
 * builder can inject as a new `<object><mesh>` and the editor can render. Output is intentionally
 * minimal — flat `positions` (3 floats/vertex) and `indices` (3 ints/triangle) plus an axis-aligned
 * bounding box — so it maps 1:1 onto 3MF `<vertices>`/`<triangles>` and onto a Three.js geometry.
 * A multi-solid STEP additionally carries its individual named solids as `parts`, so the editor
 * imports it as one object with many parts (rather than collapsing the assembly into one blob).
 *
 * STEP tessellation uses `occt-import-js` (OpenCASCADE compiled to WASM); the ~7 MB module is loaded
 * lazily on first STEP import so STL-only installs never pay for it. The tessellation quality is
 * pinned to BambuStudio's defaults (`STEP_TESSELLATION`) so an imported STEP matches what the same
 * file looks like opened in BambuStudio.
 */
import type { StagedImportFormat } from '@printstream/shared'
import type { OcctTriangulationParams } from 'occt-import-js'

export interface ImportedMeshBounds {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

export interface ImportedMesh {
  /** Flat vertex coordinates, 3 (x,y,z) per vertex. */
  positions: number[]
  /** Flat triangle vertex indices, 3 per triangle. */
  indices: number[]
  bounds: ImportedMeshBounds
  /**
   * Individual named solids when the source held more than one (a multi-solid STEP
   * assembly). Each part is a self-contained mesh in the same coordinate space as the
   * merged geometry above, so the editor can render and the 3MF builder can bake them
   * as separate parts of one object. Absent (undefined) for single-solid STEP and STL,
   * where the merged mesh is the whole import.
   */
  parts?: ImportedMeshPart[]
}

/** One named solid from a multi-solid import (a STEP assembly's part). */
export interface ImportedMeshPart {
  name: string
  mesh: ImportedMesh
}

const MAX_IMPORT_TRIANGLES = 5_000_000

/** Detect the import format from a file name extension. Returns null for unsupported types. */
export function detectImportFormat(fileName: string): StagedImportFormat | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.stl')) return 'stl'
  if (lower.endsWith('.step') || lower.endsWith('.stp')) return 'step'
  if (lower.endsWith('.3mf')) return '3mf'
  return null
}

/** Parse the supported formats to a mesh. 3MF extraction is handled by the caller (object-aware). */
export async function parseImportedMesh(buffer: Buffer, format: StagedImportFormat): Promise<ImportedMesh> {
  if (format === 'stl') return parseStlMesh(buffer)
  if (format === 'step') return tessellateStepMesh(buffer)
  throw new Error(`Unsupported import format: ${format}`)
}

/** Parse a binary or ASCII STL into a (non-indexed) triangle mesh. */
export function parseStlMesh(buffer: Buffer): ImportedMesh {
  const mesh = isBinaryStl(buffer) ? parseBinaryStl(buffer) : parseAsciiStl(buffer)
  if (mesh.indices.length === 0) throw new Error('STL contained no triangles')
  return mesh
}

/**
 * Binary STL detection: a binary file is 84 + 50*triangles bytes. ASCII STLs start with "solid" but
 * so can binary headers, so the size check is the reliable discriminator.
 */
function isBinaryStl(buffer: Buffer): boolean {
  if (buffer.length < 84) return false
  const triangles = buffer.readUInt32LE(80)
  return buffer.length === 84 + triangles * 50
}

function parseBinaryStl(buffer: Buffer): ImportedMesh {
  const triangles = buffer.readUInt32LE(80)
  if (triangles > MAX_IMPORT_TRIANGLES) throw new Error('STL is too large to import')
  const positions: number[] = []
  const indices: number[] = []
  const accumulator = new BoundsAccumulator()
  let offset = 84
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    offset += 12 // skip the per-facet normal
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const x = buffer.readFloatLE(offset)
      const y = buffer.readFloatLE(offset + 4)
      const z = buffer.readFloatLE(offset + 8)
      offset += 12
      indices.push(positions.length / 3)
      positions.push(x, y, z)
      accumulator.add(x, y, z)
    }
    offset += 2 // attribute byte count
  }
  return { positions, indices, bounds: accumulator.bounds() }
}

function parseAsciiStl(buffer: Buffer): ImportedMesh {
  const positions: number[] = []
  const indices: number[] = []
  const accumulator = new BoundsAccumulator()
  const vertexPattern = /vertex\s+(-?[0-9eE.+-]+)\s+(-?[0-9eE.+-]+)\s+(-?[0-9eE.+-]+)/g
  const text = buffer.toString('utf8')
  let match: RegExpExecArray | null
  while ((match = vertexPattern.exec(text)) !== null) {
    const x = Number.parseFloat(match[1] ?? '')
    const y = Number.parseFloat(match[2] ?? '')
    const z = Number.parseFloat(match[3] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    indices.push(positions.length / 3)
    positions.push(x, y, z)
    accumulator.add(x, y, z)
    if (indices.length > MAX_IMPORT_TRIANGLES * 3) throw new Error('STL is too large to import')
  }
  if (positions.length % 9 !== 0) {
    // Drop a trailing partial triangle rather than emitting a malformed mesh.
    const usableVertices = Math.floor(positions.length / 9) * 9
    positions.length = usableVertices
    indices.length = usableVertices / 3
  }
  return { positions, indices, bounds: accumulator.bounds() }
}

type OcctInstance = Awaited<ReturnType<typeof import('occt-import-js').default>>
let occtInstancePromise: Promise<OcctInstance> | null = null

/**
 * STEP triangulation quality, matched to BambuStudio's defaults so an imported STEP looks identical
 * to opening the same file in BambuStudio. BambuStudio meshes each STEP solid with
 * `BRepMesh_IncrementalMesh(solid, linear_deflection, isRelative=false, angle_deflection, inParallel=true)`
 * where `load_step` defaults `linear_deflection = 0.003` and `angle_deflection = 0.5` (BambuStudio
 * `src/libslic3r/Format/STEP.{hpp,cpp}`): an ABSOLUTE 0.003 mm chord error and a 0.5 rad angular
 * deflection on a shape expressed in millimetres. occt-import-js loads STEP geometry already scaled
 * to `linearUnit`, so `absolute_value` + `millimeter` applies the chord error in mm exactly as
 * BambuStudio does. Its `null`-params default (a 0.001 bounding-box ratio ≈ 0.03–0.3 mm chord error
 * for typical parts) visibly facets curved surfaces; these values fix that.
 */
export const STEP_TESSELLATION: OcctTriangulationParams = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.003,
  angularDeflection: 0.5
}

/**
 * Tessellate a STEP file via OpenCASCADE (WASM), loaded lazily. OCCT returns one mesh per solid;
 * we keep each as a named {@link ImportedMeshPart} (so a multi-solid assembly imports as one object
 * with many parts, matching BambuStudio) AND a merged mesh (used for bounds, triangle count, and the
 * single-mesh render/bake path). Only when more than one solid is present is `parts` populated.
 */
export async function tessellateStepMesh(buffer: Buffer): Promise<ImportedMesh> {
  const { default: occtimportjs } = await import('occt-import-js')
  if (!occtInstancePromise) occtInstancePromise = occtimportjs()
  const occt = await occtInstancePromise
  const result = occt.ReadStepFile(new Uint8Array(buffer), STEP_TESSELLATION)
  if (!result.success || result.meshes.length === 0) throw new Error('STEP file could not be tessellated')

  const parts: ImportedMeshPart[] = result.meshes
    .map((mesh, index) => ({ name: (mesh.name ?? '').trim() || `Part ${index + 1}`, mesh: occtMeshToImportedMesh(mesh) }))
    .filter((part) => part.mesh.indices.length > 0)
  if (parts.length === 0) throw new Error('STEP file produced no geometry')

  const merged = mergeImportedMeshes(parts.map((part) => part.mesh))
  return parts.length > 1 ? { ...merged, parts } : merged
}

/** Convert a single OCCT mesh (positions + index arrays) into an {@link ImportedMesh}. */
function occtMeshToImportedMesh(mesh: { attributes: { position: { array: number[] } }; index: { array: number[] } }): ImportedMesh {
  const positions: number[] = []
  const accumulator = new BoundsAccumulator()
  const source = mesh.attributes.position.array
  for (let i = 0; i < source.length; i += 3) {
    const x = source[i] ?? 0
    const y = source[i + 1] ?? 0
    const z = source[i + 2] ?? 0
    positions.push(x, y, z)
    accumulator.add(x, y, z)
  }
  return { positions, indices: [...mesh.index.array], bounds: accumulator.bounds() }
}

/** Concatenate meshes into one (re-basing each mesh's indices), recomputing the combined bounds. */
function mergeImportedMeshes(meshes: ImportedMesh[]): ImportedMesh {
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
export function meshToBinaryStl(mesh: ImportedMesh): Buffer {
  const triangleCount = Math.floor(mesh.indices.length / 3)
  const buffer = Buffer.alloc(84 + triangleCount * 50)
  buffer.writeUInt32LE(triangleCount, 80)
  let offset = 84
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    offset += 12 // zeroed facet normal; slicers recompute from winding
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const base = (mesh.indices[triangle * 3 + vertex] ?? 0) * 3
      buffer.writeFloatLE(mesh.positions[base] ?? 0, offset)
      buffer.writeFloatLE(mesh.positions[base + 1] ?? 0, offset + 4)
      buffer.writeFloatLE(mesh.positions[base + 2] ?? 0, offset + 8)
      offset += 12
    }
    offset += 2 // attribute byte count
  }
  return buffer
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
