/**
 * Mesh geometry repair for the meshes inside a 3MF — a numeric, admesh-equivalent pass that goes
 * beyond the exact-duplicate weld in `three-mf-mesh-weld.ts`.
 *
 * What it owns: turning a structurally-imperfect mesh into one the slicer can chew on, mirroring the
 * load-bearing, *non-destructive* steps BambuStudio's own `TriangleMesh::repair()` runs on STL import
 * (`admesh/util.cpp` → `stl_check_facets_exact` + `stl_check_facets_nearby` + degenerate/duplicate
 * pruning). BambuStudio applies that repair to STL/STEP imports but trusts a 3MF's triangles verbatim,
 * so a 3MF authored from a cracked or soup mesh reaches the slicer unrepaired.
 *
 * Contract: this is a **safe** repair — it only *merges coincident geometry and drops junk*, never
 * invents or deletes surface:
 *   1. Nearby-vertex weld — merge vertices within a small tolerance into one. This is the step the
 *      exact-string weld can't do: sub-tolerance cracks (two corners that should be one vertex but
 *      differ in the last float digit) leave BambuStudio chaining layer contours across a gap, which
 *      mangles small features and, on some geometry, crashes the engine. Exact duplicates are a
 *      subset, so this also subsumes the exact weld.
 *   2. Drop degenerate triangles — corners that collapsed onto a shared vertex after welding (zero
 *      area), which the slicer would otherwise trip over.
 *   3. Drop duplicate facets — the same unordered vertex triple appearing twice (coincident faces).
 *
 * Deliberately NOT attempted: normal-direction / winding repair and hole filling. BambuStudio itself
 * disables admesh hole-filling ("does more harm than good … let the slicing algorithm close gaps in
 * 2D"), and its slicer tolerates winding on a watertight mesh; a mis-orientation "fix" on an already
 * fine mesh is a net risk. Note that this is why repair does NOT fix every unsliceable model — a clean
 * manifold mesh that crashes the engine on its 2D geometry has nothing here to repair (see the
 * engine-crash path in the slicer's `slice-error.ts`).
 *
 * Every non-index triangle attribute (paint codes) rides along unchanged, exactly as the weld heal
 * preserves them. Best-effort: an unreadable/oversized or non-conforming entry is left untouched
 * rather than failing the operation.
 *
 * Two callers: the slice pre-pass ({@link repairThreeMfMeshesToCopy}, best-effort, never fails a
 * slice) and the editor's explicit "Repair mesh" action (which persists the repaired copy as a new
 * library version and shows the user what was fixed).
 */
import yauzl from 'yauzl'
import { readEntry, rewriteThreeMfEntries } from './three-mf-internal.js'

const VERTEX_TAG_PATTERN = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"\s*\/>/g
const TRIANGLE_TAG_PATTERN = /[ \t]*<triangle\b([^>]*)\/>\s*?\n?/g

/** Counts of what a repair changed, for the caller to log / show the user. All zero ⇒ nothing to do. */
export interface MeshRepairStats {
  /** Vertices merged away by the nearby-weld (includes exact duplicates). */
  weldedVertices: number
  /** Triangles dropped because they collapsed to zero area after welding. */
  degenerateTrianglesRemoved: number
  /** Triangles dropped as exact duplicates of another (same unordered vertex triple). */
  duplicateTrianglesRemoved: number
}

const EMPTY_STATS: MeshRepairStats = { weldedVertices: 0, degenerateTrianglesRemoved: 0, duplicateTrianglesRemoved: 0 }

function isEmpty(stats: MeshRepairStats): boolean {
  return stats.weldedVertices === 0 && stats.degenerateTrianglesRemoved === 0 && stats.duplicateTrianglesRemoved === 0
}

function addStats(a: MeshRepairStats, b: MeshRepairStats): MeshRepairStats {
  return {
    weldedVertices: a.weldedVertices + b.weldedVertices,
    degenerateTrianglesRemoved: a.degenerateTrianglesRemoved + b.degenerateTrianglesRemoved,
    duplicateTrianglesRemoved: a.duplicateTrianglesRemoved + b.duplicateTrianglesRemoved
  }
}

interface ParsedVertex {
  x: number
  y: number
  z: number
  tag: string
}

/**
 * The nearby-weld tolerance for a mesh, in model units (mm). Derived from the mesh's bounding box so a
 * huge model gets a proportionally larger snap distance, with an absolute floor for tiny models. The
 * ceiling keeps it well below any real feature so distinct vertices are never merged: 2e-4 of the
 * bbox diagonal is ~0.04mm on a 200mm model — larger than float round-trip noise, far smaller than a
 * printable wall. Mirrors the spirit of admesh seeding its tolerance from the mesh's shortest edge.
 */
function weldToleranceFor(vertices: readonly ParsedVertex[]): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const v of vertices) {
    if (v.x < minX) minX = v.x
    if (v.y < minY) minY = v.y
    if (v.z < minZ) minZ = v.z
    if (v.x > maxX) maxX = v.x
    if (v.y > maxY) maxY = v.y
    if (v.z > maxZ) maxZ = v.z
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
  if (!Number.isFinite(diagonal) || diagonal <= 0) return 1e-5
  return Math.max(1e-5, diagonal * 2e-4)
}

/**
 * Build a remap from each input vertex index to a canonical vertex index, merging vertices within
 * `tolerance`. Uses a spatial hash on a grid of cell size `tolerance` and scans the 27 cells around
 * each vertex, so a match straddling a cell boundary is still found. Returns the remap plus the
 * canonical vertices (kept in first-seen order, so the output preserves the original vertex tags).
 */
function buildNearbyWeldRemap(vertices: readonly ParsedVertex[], tolerance: number): { remap: number[]; canonical: ParsedVertex[] } {
  const cell = tolerance
  const tolSq = tolerance * tolerance
  const canonical: ParsedVertex[] = []
  const remap: number[] = new Array(vertices.length)
  // Grid cell key -> canonical vertex indices whose vertex falls in that cell.
  const grid = new Map<string, number[]>()

  const cellKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`

  for (let i = 0; i < vertices.length; i += 1) {
    const v = vertices[i]!
    const cx = Math.floor(v.x / cell)
    const cy = Math.floor(v.y / cell)
    const cz = Math.floor(v.z / cell)
    let found = -1
    // Scan the 3x3x3 neighborhood so a near-duplicate one cell over is still merged.
    for (let dx = -1; dx <= 1 && found === -1; dx += 1) {
      for (let dy = -1; dy <= 1 && found === -1; dy += 1) {
        for (let dz = -1; dz <= 1 && found === -1; dz += 1) {
          const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz))
          if (!bucket) continue
          for (const ci of bucket) {
            const c = canonical[ci]!
            const ddx = c.x - v.x
            const ddy = c.y - v.y
            const ddz = c.z - v.z
            if (ddx * ddx + ddy * ddy + ddz * ddz <= tolSq) {
              found = ci
              break
            }
          }
        }
      }
    }
    if (found === -1) {
      const index = canonical.length
      canonical.push(v)
      const key = cellKey(cx, cy, cz)
      const bucket = grid.get(key)
      if (bucket) bucket.push(index)
      else grid.set(key, [index])
      remap[i] = index
    } else {
      remap[i] = found
    }
  }
  return { remap, canonical }
}

/**
 * Repair a single `<mesh>` XML block. Returns the rewritten XML and what changed, or null when the
 * mesh is already clean or does not match the expected serialization (left untouched for safety).
 */
export function repairSingleMeshXml(meshXml: string): { xml: string; stats: MeshRepairStats } | null {
  const verticesMatch = /<vertices>([\s\S]*?)<\/vertices>/.exec(meshXml)
  const trianglesMatch = /<triangles>([\s\S]*?)<\/triangles>/.exec(meshXml)
  if (!verticesMatch || !trianglesMatch) return null

  const vertices: ParsedVertex[] = []
  VERTEX_TAG_PATTERN.lastIndex = 0
  let vMatch: RegExpExecArray | null
  while ((vMatch = VERTEX_TAG_PATTERN.exec(verticesMatch[1] ?? '')) !== null) {
    const x = Number(vMatch[1])
    const y = Number(vMatch[2])
    const z = Number(vMatch[3])
    // A non-numeric coordinate means this isn't the serialization we understand; bail rather than
    // silently corrupting geometry.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    vertices.push({ x, y, z, tag: vMatch[0] })
  }
  if (vertices.length === 0) return null

  const { remap, canonical } = buildNearbyWeldRemap(vertices, weldToleranceFor(vertices))
  const weldedVertices = vertices.length - canonical.length

  let degenerateTrianglesRemoved = 0
  let duplicateTrianglesRemoved = 0
  let malformed = false
  const seenTriangles = new Set<string>()
  const trianglesXml = (trianglesMatch[1] ?? '').replace(TRIANGLE_TAG_PATTERN, (full, attrs: string) => {
    const v1 = /\bv1="(\d+)"/.exec(attrs)
    const v2 = /\bv2="(\d+)"/.exec(attrs)
    const v3 = /\bv3="(\d+)"/.exec(attrs)
    if (!v1 || !v2 || !v3) {
      malformed = true
      return full
    }
    const a = remap[Number.parseInt(v1[1] ?? '', 10)]
    const b = remap[Number.parseInt(v2[1] ?? '', 10)]
    const c = remap[Number.parseInt(v3[1] ?? '', 10)]
    if (a == null || b == null || c == null) {
      malformed = true
      return full
    }
    // Zero area after welding: two corners collapsed onto one vertex.
    if (a === b || b === c || c === a) {
      degenerateTrianglesRemoved += 1
      return ''
    }
    // Exact duplicate facet: same unordered vertex triple already emitted. Key on the sorted triple
    // so a duplicate written with a different corner-start or winding is still caught.
    const key = [a, b, c].sort((p, q) => p - q).join('_')
    if (seenTriangles.has(key)) {
      duplicateTrianglesRemoved += 1
      return ''
    }
    seenTriangles.add(key)
    const updated = attrs
      .replace(/\bv1="\d+"/, `v1="${a}"`)
      .replace(/\bv2="\d+"/, `v2="${b}"`)
      .replace(/\bv3="\d+"/, `v3="${c}"`)
    return full.replace(attrs, updated)
  })
  if (malformed) return null

  const stats: MeshRepairStats = { weldedVertices, degenerateTrianglesRemoved, duplicateTrianglesRemoved }
  if (isEmpty(stats)) return null

  const verticesXml = `\n${canonical.map((v) => `     ${v.tag}`).join('\n')}\n    `
  const xml = meshXml
    .replace(/<vertices>[\s\S]*?<\/vertices>/, () => `<vertices>${verticesXml}</vertices>`)
    .replace(/<triangles>[\s\S]*?<\/triangles>/, () => `<triangles>${trianglesXml}</triangles>`)
  return { xml, stats }
}

/** Repair every `<mesh>` in a 3MF model entry's XML. Returns the rewritten XML + stats, or null if nothing changed. */
export function repairModelEntryMeshes(xml: string): { xml: string; stats: MeshRepairStats } | null {
  let total = EMPTY_STATS
  const rewritten = xml.replace(/<mesh>[\s\S]*?<\/mesh>/g, (meshXml) => {
    const repaired = repairSingleMeshXml(meshXml)
    if (!repaired) return meshXml
    total = addStats(total, repaired.stats)
    return repaired.xml
  })
  return isEmpty(total) ? null : { xml: rewritten, stats: total }
}

/** Entry names that can carry mesh geometry: the root model and any object part files. */
function isModelEntryName(name: string): boolean {
  return name === '3D/3dmodel.model' || /^3D\/Objects\/[^/]+\.model$/.test(name)
}

function listModelEntryNames(sourcePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(sourcePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('Failed to open 3MF'))
        return
      }
      const names: string[] = []
      zipFile.on('error', reject)
      zipFile.on('end', () => resolve(names))
      zipFile.on('entry', (entry: { fileName: string }) => {
        if (isModelEntryName(entry.fileName)) names.push(entry.fileName)
        zipFile.readEntry()
      })
      zipFile.readEntry()
    })
  })
}

/** Same cap the scene reader uses for the root model entry. */
const MAX_MODEL_ENTRY_BYTES = 64 * 1024 * 1024

/**
 * Produce a copy of `sourcePath` at `outputPath` with every mesh repaired (see the module header).
 * Returns the aggregate {@link MeshRepairStats} when a repaired copy was written, or null when nothing
 * needed repair (no copy is produced — the caller keeps using the original). Best-effort: an
 * unreadable/oversized entry is skipped with a warning rather than throwing.
 */
export async function repairThreeMfMeshesToCopy(sourcePath: string, outputPath: string): Promise<MeshRepairStats | null> {
  const entryNames = await listModelEntryNames(sourcePath)
  const transforms: Record<string, (xml: string) => string> = {}
  let total = EMPTY_STATS
  for (const name of entryNames) {
    let xml: string
    try {
      xml = (await readEntry(sourcePath, name, undefined, MAX_MODEL_ENTRY_BYTES)).toString('utf8')
    } catch (error) {
      console.warn(`[mesh-repair] skipped ${name}:`, error instanceof Error ? error.message : error)
      continue
    }
    const repaired = repairModelEntryMeshes(xml)
    if (repaired) {
      transforms[name] = () => repaired.xml
      total = addStats(total, repaired.stats)
    }
  }
  if (Object.keys(transforms).length === 0) return null
  await rewriteThreeMfEntries(sourcePath, outputPath, transforms)
  return total
}
