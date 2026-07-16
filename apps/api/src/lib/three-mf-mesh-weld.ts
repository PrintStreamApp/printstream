/**
 * Slice-time healing for index-level triangle-soup meshes inside a 3MF.
 *
 * Editor mesh imports used to be baked with one vertex entry per triangle corner (STL is
 * soup by definition; OCCT tessellates each BRep face independently). BambuStudio's
 * slicer chains layer contours by vertex/edge INDEX (`chain_open_polylines_exact`), so a
 * soup mesh falls entirely into its 2mm proximity gap-closing heuristic, which
 * mis-stitches small features — zero-clearance inlays (embossed text pockets) print
 * fused/unfilled as if the wall generator were broken. New imports are welded at parse
 * time (`mesh-import.ts`); this module heals PREVIOUSLY-SAVED projects on their way to
 * the slicer, without touching the library file itself.
 *
 * Welding uses exact attribute-string equality (duplicated corners were serialized from
 * the same source floats), preserves every non-index triangle attribute (paint codes),
 * and drops triangles that degenerate after the weld. Already-welded meshes pass through
 * untouched, so running this over BambuStudio-authored entries is a no-op.
 */
import yauzl from 'yauzl'
import { readEntry, rewriteThreeMfEntries } from './three-mf-internal.js'

const VERTEX_TAG_PATTERN = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"\s*\/>/g
const TRIANGLE_TAG_PATTERN = /[ \t]*<triangle\b([^>]*)\/>\s*?\n?/g

/**
 * Weld exact-duplicate vertices in every `<mesh>` of a 3MF model entry. Returns the
 * rewritten XML, or null when nothing needed welding (or a mesh didn't match the
 * expected serialization, in which case it is left untouched for safety).
 */
export function weldModelEntryMeshes(xml: string): string | null {
  let changed = false
  const rewritten = xml.replace(/<mesh>[\s\S]*?<\/mesh>/g, (meshXml) => {
    const welded = weldSingleMeshXml(meshXml)
    if (welded == null) return meshXml
    changed = true
    return welded
  })
  return changed ? rewritten : null
}

function weldSingleMeshXml(meshXml: string): string | null {
  const verticesMatch = /<vertices>([\s\S]*?)<\/vertices>/.exec(meshXml)
  const trianglesMatch = /<triangles>([\s\S]*?)<\/triangles>/.exec(meshXml)
  if (!verticesMatch || !trianglesMatch) return null

  const vertexTags: string[] = []
  const keyToIndex = new Map<string, number>()
  const remap: number[] = []
  let vertexCount = 0
  VERTEX_TAG_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = VERTEX_TAG_PATTERN.exec(verticesMatch[1] ?? '')) !== null) {
    vertexCount += 1
    const key = `${match[1]},${match[2]},${match[3]}`
    let index = keyToIndex.get(key)
    if (index == null) {
      index = vertexTags.length
      keyToIndex.set(key, index)
      vertexTags.push(match[0])
    }
    remap.push(index)
  }
  if (vertexCount === 0 || vertexTags.length === vertexCount) return null

  let malformed = false
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
    // Degenerate after welding: the triangle's corners collapsed onto shared vertices.
    if (a === b || b === c || c === a) return ''
    // Rewrite only the index attributes; anything else (paint codes) rides along.
    const updated = attrs
      .replace(/\bv1="\d+"/, `v1="${a}"`)
      .replace(/\bv2="\d+"/, `v2="${b}"`)
      .replace(/\bv3="\d+"/, `v3="${c}"`)
    return full.replace(attrs, updated)
  })
  if (malformed) return null

  const verticesXml = `\n${vertexTags.map((tag) => `     ${tag}`).join('\n')}\n    `
  return meshXml
    .replace(/<vertices>[\s\S]*?<\/vertices>/, () => `<vertices>${verticesXml}</vertices>`)
    .replace(/<triangles>[\s\S]*?<\/triangles>/, () => `<triangles>${trianglesXml}</triangles>`)
}

/** Entry names that can carry mesh geometry: the root model and any object part files. */
function isModelEntryName(name: string): boolean {
  return name === '3D/3dmodel.model' || (/^3D\/Objects\/[^/]+\.model$/.test(name))
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
 * Produce a copy of `sourcePath` at `outputPath` with all soup meshes welded. Returns
 * true when a healed copy was written; false when every mesh was already welded (no
 * copy is produced — the caller keeps slicing the original).
 */
export async function healUnweldedThreeMfMeshes(sourcePath: string, outputPath: string): Promise<boolean> {
  const entryNames = await listModelEntryNames(sourcePath)
  const transforms: Record<string, (xml: string) => string> = {}
  for (const name of entryNames) {
    let xml: string
    try {
      xml = (await readEntry(sourcePath, name, undefined, MAX_MODEL_ENTRY_BYTES)).toString('utf8')
    } catch (error) {
      // An oversized/unreadable entry is left as-is: healing is best-effort and must
      // never fail a slice that would previously have run.
      console.warn(`[slicing] mesh-weld heal skipped ${name}:`, error instanceof Error ? error.message : error)
      continue
    }
    const welded = weldModelEntryMeshes(xml)
    if (welded != null) transforms[name] = () => welded
  }
  if (Object.keys(transforms).length === 0) return false
  await rewriteThreeMfEntries(sourcePath, outputPath, transforms)
  return true
}
