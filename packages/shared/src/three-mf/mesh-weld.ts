/**
 * Exact-duplicate mesh welding used when an existing 3MF is prepared for slicing.
 *
 * Older editor imports wrote one vertex per triangle corner. The slicer chains contours by
 * vertex index, so those triangle-soup meshes can be mis-stitched even though their coordinates
 * meet exactly. This transform is deliberately narrower than the editor's requested mesh repair:
 * it only merges vertices with identical serialized coordinates, preserves triangle attributes,
 * and drops triangles that become degenerate after the merge.
 */

const VERTEX_TAG_PATTERN = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"\s*\/>/g
const TRIANGLE_TAG_PATTERN = /[ \t]*<triangle\b([^>]*)\/>\s*?\n?/g

/** Whether an archive entry can contain 3MF mesh geometry. */
export function isThreeMfModelEntryPath(name: string): boolean {
  return name === '3D/3dmodel.model' || /^3D\/Objects\/[^/]+\.model$/.test(name)
}

/**
 * Weld exact-duplicate vertices in every `<mesh>` of a model entry. Returns null when no mesh
 * needed welding, or when a mesh does not match the expected serialization and is left unchanged.
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
    if (a === b || b === c || c === a) return ''
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
