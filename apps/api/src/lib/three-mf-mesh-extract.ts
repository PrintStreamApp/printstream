/**
 * Geometry-only extraction of a 3MF's printed meshes into a staged-import mesh
 * (BambuStudio's "load geometry only"), so a 3MF can be added to an open editor
 * project — or swapped in via Replace — exactly like an STL/STEP import.
 *
 * Contract: the extracted geometry is the file's FIRST non-empty plate, one part per
 * placed part (multi-instance objects contribute one part per copy), keeping the parts'
 * as-authored arrangement but re-centred as a group on the XY origin at Z=0 (see
 * {@link recentreParts}), so the editor can place the import like any STL/STEP. Helper volumes
 * (negative/modifier/support blocker/enforcer) are never included — same rule as the
 * editor's STL export. Project-level data (materials, paint, settings, plates beyond
 * the first) is deliberately dropped: this is a geometry import, not a project merge.
 * With `objectId`, only that object's first instance is extracted, in object-local
 * coordinates (the Replace flow keeps the target's placement).
 *
 * Vanilla 3MFs (no Bambu `Metadata/model_settings.config`) fall back to a root-model
 * parse: every build item is extracted with its build transform, named from the
 * `<object name>` attribute. Meshes keep their source indexing (3MF is already an
 * indexed format), so no weld pass is needed — unlike STL/STEP parsing.
 *
 * Counterpart: the editor renders the result via the staged-import mesh routes
 * (`apps/web/src/plugins/model-studio/lib/editorImports.ts`), and the save bakes it
 * through `resolveSceneEditImports` like any other import.
 */
import { isNonRenderableThreeMfPartSubtype } from '@printstream/shared'
import { badRequest } from './http-error.js'
import { MAX_IMPORT_TRIANGLES, type ImportedMesh, type ImportedMeshPart } from './mesh-import.js'
import { readEntry } from './three-mf-internal.js'
import {
  composeThreeMfTransforms,
  parseRootBuildItemTransforms,
  parseRootModelComponents,
  readPlateIndex,
  readSceneManifest
} from './three-mf-reader.js'

/** Same cap the scene reader uses for mesh-bearing model entries. */
const MAX_MODEL_ENTRY_BYTES = 64 * 1024 * 1024

/** Guards against a malicious/degenerate component graph (self-referential objects). */
const MAX_COMPONENT_DEPTH = 8

const IDENTITY_TRANSFORM: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

interface ExtractedPartSource {
  entryPath: string
  objectId: number
  /** Transform into the import's shared space (baked into the vertices). */
  transform: readonly number[]
  name: string | null
}

/**
 * Extract a 3MF's printed geometry as a staged-import mesh. Throws `badRequest` with a
 * user-facing message when the file holds no importable geometry or exceeds the import
 * triangle cap. `objectId` narrows the extraction to one object (Bambu object id).
 */
export async function extractThreeMfImportMesh(
  filePath: string,
  options?: { objectId?: number }
): Promise<ImportedMesh> {
  const sources = await resolvePartSources(filePath, options?.objectId)
  if (sources.length === 0) {
    throw badRequest(options?.objectId != null
      ? 'That object was not found in this 3MF.'
      : 'This 3MF contains no importable model geometry.')
  }

  const entryXmlCache = new Map<string, string>()
  const parts: ImportedMeshPart[] = []
  const nameCounts = new Map<string, number>()
  let totalTriangles = 0
  for (const source of sources) {
    const mesh = await extractComponentMesh(filePath, entryXmlCache, source.entryPath, source.objectId, source.transform, 0)
    if (!mesh || mesh.indices.length === 0) continue
    totalTriangles += mesh.indices.length / 3
    if (totalTriangles > MAX_IMPORT_TRIANGLES) {
      throw badRequest('This 3MF has too many triangles to import.')
    }
    const base = source.name?.trim() || `Part ${parts.length + 1}`
    const count = (nameCounts.get(base) ?? 0) + 1
    nameCounts.set(base, count)
    parts.push({ name: count === 1 ? base : `${base} (${count})`, mesh })
  }
  if (parts.length === 0) {
    throw badRequest('This 3MF contains no importable model geometry.')
  }
  return mergeParts(recentreParts(parts))
}

/**
 * Translate every part by ONE shared offset so the import's merged footprint is centred
 * on the XY origin and rests on Z=0, preserving the parts' relative arrangement. The
 * extracted meshes otherwise carry the source file's plate-absolute coordinates, and the
 * editor places an import by its instance position assuming near-origin mesh coordinates
 * (like a typical STL/STEP) — without this the import lands plate-offset-plus-spot, off
 * the bed.
 */
function recentreParts(parts: ImportedMeshPart[]): ImportedMeshPart[] {
  const merged = parts.length === 1 ? parts[0]!.mesh : mergeMeshes(parts.map((part) => part.mesh))
  const offsetX = (merged.bounds.min.x + merged.bounds.max.x) / 2
  const offsetY = (merged.bounds.min.y + merged.bounds.max.y) / 2
  const offsetZ = merged.bounds.min.z
  if (offsetX === 0 && offsetY === 0 && offsetZ === 0) return parts
  return parts.map((part) => {
    const positions = part.mesh.positions
    for (let i = 0; i + 2 < positions.length; i += 3) {
      positions[i]! -= offsetX
      positions[i + 1]! -= offsetY
      positions[i + 2]! -= offsetZ
    }
    return { ...part, mesh: { ...part.mesh, bounds: computeBounds(positions) } }
  })
}

/**
 * Resolve which (entryPath, objectId, transform) tuples make up the import. Prefers the
 * Bambu-aware scene parse (plate assignment + part subtypes); falls back to a plain
 * root-model build parse for vanilla 3MFs without Bambu metadata.
 */
async function resolvePartSources(filePath: string, objectId?: number): Promise<ExtractedPartSource[]> {
  try {
    return await resolveSceneSources(filePath, objectId)
  } catch {
    // Missing/foreign Metadata (a vanilla 3MF): fall back to the root model's own build
    // items. Real read failures (corrupt ZIP) resurface from the fallback's readEntry.
    return resolveVanillaSources(filePath, objectId)
  }
}

async function resolveSceneSources(filePath: string, objectId?: number): Promise<ExtractedPartSource[]> {
  const index = await readPlateIndex(filePath)
  const plateIndexes = index.plates.length > 0 ? index.plates.map((plate) => plate.index) : [1]
  for (const plateIndex of plateIndexes) {
    const scene = await readSceneManifest(filePath, plateIndex)
    if (objectId != null) {
      // Object-scoped (the Replace flow): the object's first instance, object-local —
      // only the component transforms apply, so the caller controls final placement.
      const instance = scene.instances.find((entry) => entry.objectId === objectId)
      if (!instance) continue
      return instance.parts
        .filter((part) => !isNonRenderableThreeMfPartSubtype(part.subtype))
        .map((part) => ({
          entryPath: part.entryPath,
          objectId: part.componentObjectId,
          transform: part.transform,
          name: instance.name
        }))
    }
    // Whole-file: the first plate that has printable parts, at plate-local placements.
    const parts = scene.parts
      .filter((part) => !isNonRenderableThreeMfPartSubtype(part.subtype))
      .map((part) => ({
        entryPath: part.entryPath,
        objectId: part.objectId,
        transform: part.transform,
        name: part.name
      }))
    if (parts.length > 0) return parts
  }
  return []
}

async function resolveVanillaSources(filePath: string, objectId?: number): Promise<ExtractedPartSource[]> {
  const rootXml = (await readEntry(filePath, '3D/3dmodel.model', undefined, MAX_MODEL_ENTRY_BYTES)).toString('utf8')
  const componentsByObjectId = parseRootModelComponents(rootXml)
  const buildTransforms = parseRootBuildItemTransforms(rootXml)
  const namesByObjectId = parseRootObjectNames(rootXml)

  const sources: ExtractedPartSource[] = []
  const pushObject = (rootObjectId: number, placement: readonly number[] | null) => {
    for (const component of componentsByObjectId.get(rootObjectId) ?? []) {
      sources.push({
        entryPath: component.entryPath,
        objectId: component.objectId,
        transform: placement ? composeThreeMfTransforms(placement, component.transform) : component.transform,
        name: namesByObjectId.get(rootObjectId) ?? null
      })
    }
  }
  if (objectId != null) {
    // Object-local, mirroring the scene path's Replace semantics.
    if (componentsByObjectId.has(objectId)) pushObject(objectId, null)
    return sources
  }
  for (const [rootObjectId, transforms] of buildTransforms) {
    for (const transform of transforms) pushObject(rootObjectId, transform)
  }
  // A build-less (or empty-build) file still has geometry worth importing: fall back to
  // every mesh-bearing object at its authored coordinates.
  if (sources.length === 0) {
    for (const rootObjectId of componentsByObjectId.keys()) pushObject(rootObjectId, IDENTITY_TRANSFORM)
  }
  return sources
}

/** `<object id>` → `name` attribute from a model entry (vanilla 3MFs name objects inline). */
function parseRootObjectNames(xml: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const match of xml.matchAll(/<object\b([^>]*)>/g)) {
    const attrs = match[1] ?? ''
    const id = Number.parseInt(/\bid="(\d+)"/.exec(attrs)?.[1] ?? '', 10)
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1]
    if (Number.isInteger(id) && id > 0 && name) out.set(id, decodeXmlEntities(name))
  }
  return out
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Read one object's mesh from a model entry, recursing through `<component>` references
 * (a sub-entry object may itself be an assembly) and baking `transform` into the vertices.
 * Returns null when the object cannot be found — the part is skipped rather than failing
 * the whole import, matching how the scene renderer tolerates dangling references.
 */
async function extractComponentMesh(
  filePath: string,
  entryXmlCache: Map<string, string>,
  entryPath: string,
  objectId: number,
  transform: readonly number[],
  depth: number
): Promise<ImportedMesh | null> {
  if (depth > MAX_COMPONENT_DEPTH) return null
  let xml = entryXmlCache.get(entryPath)
  if (xml == null) {
    try {
      xml = (await readEntry(filePath, entryPath, undefined, MAX_MODEL_ENTRY_BYTES)).toString('utf8')
    } catch {
      return null
    }
    entryXmlCache.set(entryPath, xml)
  }
  const block = findObjectBlock(xml, objectId)
  if (!block) return null

  const meshXml = /<mesh\b[^>]*>[\s\S]*?<\/mesh>/.exec(block)?.[0]
  if (meshXml) return parseMeshXml(meshXml, transform)

  // No inline mesh: resolve the object's own components (nested assembly).
  const collected: ImportedMesh[] = []
  for (const match of block.matchAll(/<component\b([^>]*)\/>/g)) {
    const attrs = match[1] ?? ''
    const childEntry = (/(?:\bp:path|\bpath)="([^"]*)"/.exec(attrs)?.[1] ?? '').replace(/^\/+/, '') || entryPath
    const childId = Number.parseInt(/\bobjectid="(\d+)"/.exec(attrs)?.[1] ?? '', 10)
    if (!Number.isInteger(childId) || childId <= 0) continue
    const childTransformAttr = /\btransform="([^"]*)"/.exec(attrs)?.[1]
    const childTransform = childTransformAttr ? parseTransformNumbers(childTransformAttr) : null
    const composed = childTransform ? composeThreeMfTransforms(transform, childTransform) : [...transform]
    const child = await extractComponentMesh(filePath, entryXmlCache, childEntry, childId, composed, depth + 1)
    if (child) collected.push(child)
  }
  if (collected.length === 0) return null
  if (collected.length === 1) return collected[0]!
  return mergeMeshes(collected)
}

/** Locate the `<object id="N">…</object>` block for exactly `objectId`. */
function findObjectBlock(xml: string, objectId: number): string | null {
  for (const match of xml.matchAll(/<object\b([^>]*)>[\s\S]*?<\/object>/g)) {
    const id = Number.parseInt(/\bid="(\d+)"/.exec(match[1] ?? '')?.[1] ?? '', 10)
    if (id === objectId) return match[0]
  }
  return null
}

function parseTransformNumbers(value: string): number[] | null {
  const numbers = value.trim().split(/\s+/).map((part) => Number.parseFloat(part))
  if (numbers.length !== 12 || numbers.some((entry) => !Number.isFinite(entry))) return null
  return numbers
}

const VERTEX_TAG_PATTERN = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"\s*\/>/g
const TRIANGLE_TAG_PATTERN = /<triangle\b([^>]*)\/>/g

/** Parse a `<mesh>` block's vertices/triangles, baking `transform` into the positions. */
function parseMeshXml(meshXml: string, transform: readonly number[]): ImportedMesh | null {
  const verticesXml = /<vertices>([\s\S]*?)<\/vertices>/.exec(meshXml)?.[1]
  const trianglesXml = /<triangles>([\s\S]*?)<\/triangles>/.exec(meshXml)?.[1]
  if (verticesXml == null || trianglesXml == null) return null

  const [t0, t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11] = [
    transform[0] ?? 1, transform[1] ?? 0, transform[2] ?? 0,
    transform[3] ?? 0, transform[4] ?? 1, transform[5] ?? 0,
    transform[6] ?? 0, transform[7] ?? 0, transform[8] ?? 1,
    transform[9] ?? 0, transform[10] ?? 0, transform[11] ?? 0
  ]
  const positions: number[] = []
  VERTEX_TAG_PATTERN.lastIndex = 0
  let vertexMatch: RegExpExecArray | null
  while ((vertexMatch = VERTEX_TAG_PATTERN.exec(verticesXml)) !== null) {
    const x = Number.parseFloat(vertexMatch[1] ?? '')
    const y = Number.parseFloat(vertexMatch[2] ?? '')
    const z = Number.parseFloat(vertexMatch[3] ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    // 12-element 3MF transform: column-major 3x3 basis then translation.
    positions.push(
      t0 * x + t3 * y + t6 * z + t9,
      t1 * x + t4 * y + t7 * z + t10,
      t2 * x + t5 * y + t8 * z + t11
    )
  }
  const vertexCount = positions.length / 3
  if (vertexCount === 0) return null

  const indices: number[] = []
  TRIANGLE_TAG_PATTERN.lastIndex = 0
  let triangleMatch: RegExpExecArray | null
  while ((triangleMatch = TRIANGLE_TAG_PATTERN.exec(trianglesXml)) !== null) {
    const attrs = triangleMatch[1] ?? ''
    const v1 = Number.parseInt(/\bv1="(\d+)"/.exec(attrs)?.[1] ?? '', 10)
    const v2 = Number.parseInt(/\bv2="(\d+)"/.exec(attrs)?.[1] ?? '', 10)
    const v3 = Number.parseInt(/\bv3="(\d+)"/.exec(attrs)?.[1] ?? '', 10)
    if (![v1, v2, v3].every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount)) continue
    indices.push(v1, v2, v3)
  }
  if (indices.length === 0) return null
  return { positions, indices, bounds: computeBounds(positions) }
}

function computeBounds(positions: number[]): ImportedMesh['bounds'] {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!
    const y = positions[i + 1]!
    const z = positions[i + 2]!
    if (x < min.x) min.x = x
    if (y < min.y) min.y = y
    if (z < min.z) min.z = z
    if (x > max.x) max.x = x
    if (y > max.y) max.y = y
    if (z > max.z) max.z = z
  }
  return { min, max }
}

function mergeMeshes(meshes: ImportedMesh[]): ImportedMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const mesh of meshes) {
    const offset = positions.length / 3
    // Element-wise (not spread): spreading a multi-million-entry array overflows the stack.
    for (const position of mesh.positions) positions.push(position)
    for (const index of mesh.indices) indices.push(index + offset)
  }
  return { positions, indices, bounds: computeBounds(positions) }
}

/** Merged import mesh; `parts` carried only when there is more than one (the STEP rule). */
function mergeParts(parts: ImportedMeshPart[]): ImportedMesh {
  if (parts.length === 1) return parts[0]!.mesh
  const merged = mergeMeshes(parts.map((part) => part.mesh))
  return { ...merged, parts }
}
