/**
 * Wavefront OBJ geometry import.
 *
 * OWNS turning `.obj` text into an {@link ImportedMesh}. Shared for the same reason `mesh-stl.ts`
 * is: the api parses an upload and the browser parses a file the user picked for the public editor,
 * where nothing leaves the machine, and a file must not import differently depending on which host
 * opened it.
 *
 * PORTED FROM BambuStudio's `load_obj` (`Format/OBJ.cpp:31`) on two decisions that a from-scratch
 * reading of the format would get wrong:
 *
 *  - **An OBJ is ONE mesh.** It builds a single `indexed_triangle_set` and never splits on `o` or
 *    `g` (`:94-99`). Those markers are draw-call and material grouping, not assembly structure, and
 *    a typical exporter emits one per material -- so splitting on them would turn a two-colour model
 *    into two objects that the user then has to reassemble. This is the deliberate difference from
 *    STEP and AMF, whose groupings genuinely ARE separate solids.
 *  - **Polygons fan-triangulate, and a face with fewer than three vertices is fatal**
 *    (`:84-90`, `num_face_vertices - 2`). Silently dropping a degenerate face would leave a hole
 *    in a model the user has no way to see is incomplete.
 *
 * Companion-file loading stays outside this module: callers resolve `mtllib` references through
 * their own storage boundary and pass parsed materials plus decoded image pixels in. In-file
 * vertex colours, MTL `Kd` face colours, and sampled `map_Kd` textures are retained per triangle
 * corner for issue #90's colour-to-filament pipeline. They are not attached to welded vertices:
 * doing that would erase a colour seam where two faces share the same position.
 */
import { assertImportTriangleBudget, computeMeshBounds, weldImportedMeshVertices } from './mesh-stl.js'
import { ModelImportError } from './imported-mesh.js'
import type { ImportedMesh } from './imported-mesh.js'
import { sampleTexturedTriangles, type DecodedTextureImage, type TexturedTriangle } from './mesh-texture.js'
import { MAX_MODEL_TEXTURE_PIXELS } from './texture-resources.js'

/** Resource ceilings shared by browser-only, API upload and library-backed OBJ imports. */
export const MAX_OBJ_MATERIAL_FILES = 8
export const MAX_OBJ_MATERIAL_BYTES = 16 * 1024 * 1024
export const MAX_OBJ_TEXTURE_FILES = 16
export const MAX_OBJ_TEXTURE_BYTES = 64 * 1024 * 1024

export interface ObjMaterialDefinition {
  color: [number, number, number, number]
  textureName?: string
  texture?: DecodedTextureImage
}

/**
 * Parse OBJ text into a single welded mesh.
 *
 * Throws when the file yields no triangles, or when a face names fewer than three vertices or an
 * out-of-range vertex -- BambuStudio refuses both rather than repairing them, and so do we, because
 * the alternative is a model with a hole the user cannot see.
 */
export function parseObjMesh(
  bytes: Uint8Array,
  options: {
    materialColors?: ReadonlyMap<string, readonly [number, number, number, number]>
    materials?: ReadonlyMap<string, ObjMaterialDefinition>
  } = {}
): ImportedMesh {
  const text = new TextDecoder().decode(bytes)
  // Avoid allocating one object plus UV/color arrays per triangle for ordinary OBJs. A crafted MTL
  // may define an unused texture, so gate on a `usemtl` that actually names a decoded texture.
  const texturedMaterialNames = new Set(
    [...(options.materials ?? [])].filter(([, material]) => material.texture != null).map(([name]) => name)
  )
  const textureImportEnabled = text.split('\n').some((rawLine) => {
    const fields = rawLine.split('#')[0]!.trim().split(/\s+/)
    return fields[0]?.toLowerCase() === 'usemtl' && texturedMaterialNames.has(fields.slice(1).join(' '))
  })
  // Flat x,y,z triples in file order. OBJ vertex references are 1-based into this list, and may be
  // NEGATIVE, meaning "counting back from the most recent vertex" -- which is why the list has to be
  // built as it is read rather than gathered in a first pass.
  const vertices: number[] = []
  // RGBA per source vertex. Alpha zero is the explicit "undefined" marker BambuStudio uses for a
  // vertex without colour once any other vertex in the OBJ establishes that colours are present.
  const vertexColors: number[] = []
  const textureCoordinates: Array<readonly [number, number]> = []
  const triangleCornerColors: number[] = []
  const texturedTriangles: TexturedTriangle[] = []
  let hasTexture = false
  let hasVertexColors = false
  let usedMaterialColors = false
  let activeMaterialColor: readonly [number, number, number, number] | undefined
  let activeMaterial: ObjMaterialDefinition | undefined
  const positions: number[] = []
  const indices: number[] = []
  let triangleCount = 0

  for (const rawLine of text.split('\n')) {
    // A backslash continues a line in OBJ, but `f` statements long enough to need one are vanishingly
    // rare and BambuStudio's own parser does not honour it either, so a continued line is read as two.
    // `#` starts a comment ANYWHERE on the line, not just at its start (BambuStudio's parser strips
    // to end of line wherever it appears). Handling only whole-line comments made a perfectly valid
    // `f 1 2 3 # bottom face` read `#` as a fourth corner and refuse the entire file as corrupt --
    // and inconsistently, since the `v` branch reads only its first three fields and tolerated it.
    const line = rawLine.split('#')[0]!.trim()
    if (line.length === 0) continue
    // Split on ANY run of whitespace, not on the first space: OBJ permits tabs as field separators
    // and real exporters emit them, where an `indexOf(' ')` finds nothing and drops the whole line.
    // Every vertex silently vanishing reads as "OBJ contained no triangles", i.e. as a corrupt file.
    const fields = line.split(/\s+/)
    const keyword = fields[0]
    if (fields.length < 2) continue

    if (keyword === 'v') {
      // Position is always the first three values; optional colour channels are a separate sidecar.
      const x = Number.parseFloat(fields[1] ?? '')
      const y = Number.parseFloat(fields[2] ?? '')
      const z = Number.parseFloat(fields[3] ?? '')
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new ModelImportError('OBJ contained a vertex with unreadable coordinates')
      }
      vertices.push(x, y, z)
      if (fields.length >= 7) {
        const color = fields.slice(4, 8).map((field) => Number.parseFloat(field ?? ''))
        if (color.slice(0, 3).some((channel) => !Number.isFinite(channel))) {
          throw new ModelImportError('OBJ contained a vertex with unreadable colour channels')
        }
        hasVertexColors = true
        vertexColors.push(
          clampColor(color[0]!),
          clampColor(color[1]!),
          clampColor(color[2]!),
          color[3] == null || !Number.isFinite(color[3]) ? 1 : clampColor(color[3])
        )
      } else {
        vertexColors.push(0, 0, 0, 0)
      }
      continue
    }

    if (keyword === 'vt') {
      if (!textureImportEnabled) continue
      const u = Number.parseFloat(fields[1] ?? '')
      const v = Number.parseFloat(fields[2] ?? '')
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        throw new ModelImportError('OBJ contained unreadable texture coordinates')
      }
      textureCoordinates.push([u, v])
      continue
    }

    if (keyword === 'usemtl') {
      const name = fields.slice(1).join(' ')
      activeMaterial = options.materials?.get(name)
      activeMaterialColor = activeMaterial?.color ?? options.materialColors?.get(name)
      continue
    }

    if (keyword !== 'f') continue

    // A face vertex is `v`, `v/vt`, `v//vn` or `v/vt/vn`; only the position index is geometry.
    const corners = fields.slice(1)
    if (corners.length < 3) {
      throw new ModelImportError('OBJ contains polygons with less than 3 vertices')
    }
    const resolved: number[] = []
    const resolvedUvs: Array<readonly [number, number] | undefined> | null = textureImportEnabled ? [] : null
    for (const corner of corners) {
      const references = corner.split('/')
      const reference = Number.parseInt(references[0] ?? '', 10)
      if (!Number.isFinite(reference) || reference === 0) {
        throw new ModelImportError('OBJ contains an unreadable vertex index')
      }
      // 1-based forwards, -1-based backwards from the vertices read so far.
      const total = vertices.length / 3
      const index = reference > 0 ? reference - 1 : total + reference
      if (index < 0 || index >= total) {
        throw new ModelImportError('OBJ contains an invalid vertex index')
      }
      resolved.push(index)

      if (resolvedUvs) {
        const uvReference = references[1] ? Number.parseInt(references[1], 10) : 0
        if (uvReference === 0) {
          resolvedUvs.push(undefined)
        } else {
          const uvIndex = uvReference > 0 ? uvReference - 1 : textureCoordinates.length + uvReference
          if (uvIndex < 0 || uvIndex >= textureCoordinates.length) {
            throw new ModelImportError('OBJ contains an invalid texture-coordinate index')
          }
          resolvedUvs.push(textureCoordinates[uvIndex])
        }
      }
    }

    // Fan from the first corner, exactly as BambuStudio does. Correct for the convex faces OBJ
    // exporters emit; a concave n-gon would need real triangulation, and Studio does not do it either.
    triangleCount += resolved.length - 2
    assertImportTriangleBudget(triangleCount)
    for (let corner = 1; corner + 1 < resolved.length; corner += 1) {
      const triangleIndices = [resolved[0]!, resolved[corner]!, resolved[corner + 1]!] as const
      const triangleUvs = resolvedUvs
        ? [resolvedUvs[0], resolvedUvs[corner], resolvedUvs[corner + 1]] as const
        : null
      const trianglePositions: Array<readonly [number, number, number]> | null = textureImportEnabled ? [] : null
      const cornerColors: Array<readonly [number, number, number, number]> | null = textureImportEnabled ? [] : null
      for (const index of triangleIndices) {
        indices.push(positions.length / 3)
        const position = [vertices[index * 3]!, vertices[index * 3 + 1]!, vertices[index * 3 + 2]!] as const
        positions.push(...position)
        trianglePositions?.push(position)
        const vertexAlpha = vertexColors[index * 4 + 3]!
        const color = vertexAlpha > 0
          ? vertexColors.slice(index * 4, index * 4 + 4)
          : activeMaterialColor
        if (color) {
          if (vertexAlpha <= 0) usedMaterialColors = true
          triangleCornerColors.push(color[0]!, color[1]!, color[2]!, color[3]!)
          cornerColors?.push([color[0]!, color[1]!, color[2]!, color[3]!])
        } else {
          triangleCornerColors.push(0, 0, 0, 0)
          cornerColors?.push([0, 0, 0, 0])
        }
      }
      if (textureImportEnabled) {
        const texture = activeMaterial?.texture
        const completeUvs = triangleUvs?.every((uv) => uv != null) ?? false
        if (texture && completeUvs) hasTexture = true
        texturedTriangles.push({
          positions: trianglePositions as [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]],
          ...(texture && completeUvs
            ? {
                texture,
                uvs: triangleUvs as [readonly [number, number], readonly [number, number], readonly [number, number]],
                // OBJ V=0 addresses the image bottom; the shared sampler flips after wrapping.
                flipV: true
              }
            : {}),
          cornerColors: cornerColors as [readonly [number, number, number, number], readonly [number, number, number, number], readonly [number, number, number, number]],
          fallbackColor: activeMaterialColor
        })
      }
    }
  }

  if (indices.length === 0) throw new ModelImportError('OBJ contained no triangles')
  if (hasTexture) return sampleTexturedTriangles(texturedTriangles)
  return weldImportedMeshVertices({
    positions,
    indices,
    bounds: computeMeshBounds(positions),
    ...(hasVertexColors || usedMaterialColors
      ? {
          triangleCornerColors,
          sourceColorMode: hasVertexColors ? 'vertex' as const : 'material' as const
        }
      : {})
  })
}

/** Parse the colour-bearing subset of a Wavefront MTL document. */
export function parseObjMaterialColors(bytes: Uint8Array): Map<string, [number, number, number, number]> {
  return new Map([...parseObjMaterials(bytes)].map(([name, material]) => [name, material.color]))
}

/** Parse diffuse colours and `map_Kd` references from a Wavefront MTL document. */
export function parseObjMaterials(bytes: Uint8Array): Map<string, ObjMaterialDefinition> {
  const materials = new Map<string, ObjMaterialDefinition>()
  let currentName: string | null = null
  for (const rawLine of new TextDecoder().decode(bytes).split('\n')) {
    const fields = rawLine.split('#')[0]!.trim().split(/\s+/)
    const keyword = fields[0]?.toLowerCase()
    if (!keyword) continue
    if (keyword === 'newmtl') {
      currentName = fields.slice(1).join(' ')
      if (currentName && !materials.has(currentName)) materials.set(currentName, { color: [0.8, 0.8, 0.8, 1] })
      continue
    }
    if (!currentName) continue
    const current = materials.get(currentName)!
    if (keyword === 'kd') {
      const channels = fields.slice(1, 4).map((field) => Number.parseFloat(field ?? ''))
      if (channels.length < 3 || channels.some((value) => !Number.isFinite(value))) {
        throw new ModelImportError(`MTL material "${currentName}" has an unreadable diffuse colour`)
      }
      current.color = [clampColor(channels[0]!), clampColor(channels[1]!), clampColor(channels[2]!), current.color[3]]
    } else if (keyword === 'd' || keyword === 'tr') {
      const value = Number.parseFloat(fields[1] ?? '')
      if (!Number.isFinite(value)) throw new ModelImportError(`MTL material "${currentName}" has unreadable transparency`)
      current.color[3] = clampColor(keyword === 'tr' ? 1 - value : value)
    } else if (keyword === 'map_kd') {
      const textureName = parseTextureMapName(fields.slice(1))
      if (textureName) current.textureName = textureName
    }
  }
  return materials
}

/** List texture basenames referenced by parsed materials. */
export function referencedObjTextures(materials: ReadonlyMap<string, ObjMaterialDefinition>): string[] {
  return [...new Set([...materials.values()].flatMap((material) => material.textureName ? [material.textureName] : []))]
}

/**
 * Resolve an OBJ's named MTL files and their texture resources from one host-provided sidecar set.
 * Missing resources fall back to `Kd`, matching BambuStudio's non-fatal missing-texture behavior.
 */
export async function resolveObjMaterials(
  objBytes: Uint8Array,
  companions: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
  decodeTexture: (name: string, bytes: Uint8Array) => Promise<DecodedTextureImage> | DecodedTextureImage
): Promise<Map<string, ObjMaterialDefinition>> {
  const requestedLibraries = new Set(referencedObjMaterialLibraries(objBytes).map(normalizeObjResourceName))
  const materials = new Map<string, ObjMaterialDefinition>()
  for (const companion of companions) {
    if (!requestedLibraries.has(normalizeObjResourceName(companion.name))) continue
    for (const [name, material] of parseObjMaterials(companion.bytes)) materials.set(name, material)
  }

  const resources = new Map(companions.map((companion) => [normalizeObjResourceName(companion.name), companion]))
  const decoded = new Map<string, DecodedTextureImage>()
  const usedMaterials = referencedObjMaterials(objBytes)
  let decodedPixels = 0
  for (const [name, material] of materials) {
    // A material library may define a large catalogue while this OBJ uses only one entry. Loading
    // every texture would let unused resources multiply decoded memory without affecting output.
    if (!usedMaterials.has(name)) continue
    if (!material.textureName) continue
    const key = normalizeObjResourceName(material.textureName)
    const resource = resources.get(key)
    if (!resource) continue
    let image = decoded.get(key)
    if (!image) {
      image = await decodeTexture(resource.name, resource.bytes)
      decodedPixels += image.width * image.height
      if (decodedPixels > MAX_MODEL_TEXTURE_PIXELS) {
        throw new ModelImportError('OBJ textures exceed the decoded pixel limit')
      }
      decoded.set(key, image)
    }
    material.texture = image
  }
  return materials
}

/** Material names actually selected by `usemtl` in an OBJ. */
function referencedObjMaterials(bytes: Uint8Array): Set<string> {
  const names = new Set<string>()
  for (const rawLine of new TextDecoder().decode(bytes).split('\n')) {
    const fields = rawLine.split('#')[0]!.trim().split(/\s+/)
    if (fields[0]?.toLowerCase() === 'usemtl') names.add(fields.slice(1).join(' '))
  }
  return names
}

/** List the material-library filenames an OBJ asks its storage host to resolve. */
export function referencedObjMaterialLibraries(bytes: Uint8Array): string[] {
  const names: string[] = []
  for (const rawLine of new TextDecoder().decode(bytes).split('\n')) {
    const fields = rawLine.split('#')[0]!.trim().split(/\s+/)
    if (fields[0]?.toLowerCase() !== 'mtllib') continue
    for (const name of fields.slice(1)) if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** Match path-bearing OBJ references to browser and library basenames, case-insensitively. */
export function normalizeObjMaterialLibraryName(name: string): string {
  return normalizeObjResourceName(name)
}

/** Match path-bearing OBJ/MTL resource references to exposed basenames, case-insensitively. */
export function normalizeObjResourceName(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
}

function clampColor(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** Skip standard MTL map options and retain the remaining path, including spaces. */
function parseTextureMapName(fields: readonly string[]): string {
  let index = 0
  while (index < fields.length && fields[index]?.startsWith('-')) {
    const option = fields[index]!.toLowerCase()
    index += 1
    if (option === '-o' || option === '-s' || option === '-t') {
      let values = 0
      while (index < fields.length && values < 3 && Number.isFinite(Number.parseFloat(fields[index]!))) {
        index += 1
        values += 1
      }
    } else {
      index += option === '-mm' ? 2 : 1
    }
  }
  return fields.slice(index).join(' ')
}
