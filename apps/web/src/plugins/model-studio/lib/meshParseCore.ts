/**
 * Worker-safe 3MF/STL mesh parsing + geometry processing.
 *
 * This is the heavy, DOM-free core of the editor's geometry load: it turns a 3MF model entry
 * (XML) or a binary STL into processed `THREE.BufferGeometry` (welded, creased, planar-patch
 * corrected). It imports only `three` / `three-stdlib` so it runs unchanged on the main thread
 * (the fallback) AND inside a Web Worker (`meshParseWorker.ts`) — which is the point: a single
 * 50 MB+ object would otherwise parse synchronously on the main thread and freeze the UI for
 * seconds. Off-threading needs a DOM-free parser, so the 3MF XML is read with regex (the same
 * approach as the shared `@printstream/shared/three-mf` index parser) rather than `DOMParser`.
 *
 * `threeMfScene.ts` keeps a `DOMParser`-based `parseThreeMfModelEntry` as the runtime fallback;
 * `meshParseCore.test.ts` asserts this regex parser produces the same vertices/indices/paint.
 */
import * as THREE from 'three'
import { STLLoader, mergeVertices, toCreasedNormals } from 'three-stdlib'

export const THREE_MF_VERTEX_WELD_TOLERANCE = 5e-2
export const THREE_MF_SMOOTH_NORMAL_ANGLE = THREE.MathUtils.degToRad(45)

/** Per-triangle paint codes keyed by triangle index (matches threeMfScene's SupportPaintCodes). */
export type MeshPaintCodes = Record<number, string>

/** Raw arrays parsed from one 3MF `<object>`'s mesh, before geometry processing. */
export interface ThreeMfMeshArrays {
  objectId: number
  positions: Float32Array
  index: Uint16Array | Uint32Array
  supportPaint: MeshPaintCodes
  seamPaint: MeshPaintCodes
  colorPaint: MeshPaintCodes
}

const VERTEX_RE = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g
const TRIANGLE_RE = /<triangle\s+v1="([^"]*)"\s+v2="([^"]*)"\s+v3="([^"]*)"([^>]*)>/g
const PAINT_SUPPORTS_RE = /paint_supports="([^"]*)"/
const PAINT_SEAM_RE = /paint_seam="([^"]*)"/
const PAINT_COLOR_RE = /paint_color="([^"]*)"/

/**
 * Parse a 3MF model entry's `<object>` meshes into raw vertex/index/paint arrays — DOM-free, so it
 * runs in a worker. Standard 3MF writes `<vertex x y z>` and `<triangle v1 v2 v3 [paint_*]>` with
 * those attributes leading (Bambu + our own writer both do), which the positional regexes rely on.
 */
export function parseThreeMfMeshArrays(xmlText: string): ThreeMfMeshArrays[] {
  const results: ThreeMfMeshArrays[] = []
  const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
  let objectMatch: RegExpExecArray | null
  while ((objectMatch = objectRe.exec(xmlText)) !== null) {
    const objectId = Number.parseInt(/\bid="(\d+)"/.exec(objectMatch[1] ?? '')?.[1] ?? '', 10)
    if (!Number.isInteger(objectId) || objectId <= 0) continue
    const body = objectMatch[2] ?? ''
    const meshStart = body.indexOf('<mesh')
    if (meshStart === -1) continue
    const mesh = body.slice(meshStart)

    // One pass per element type into plain arrays. The regexes match only real vertex/triangle tags
    // (they require the leading attributes), so the <vertices>/<triangles> container tags are
    // skipped — avoiding an off-by-one from counting '<triangle' inside '<triangles>'.
    const positionsList: number[] = []
    VERTEX_RE.lastIndex = 0
    let vertexMatch: RegExpExecArray | null
    while ((vertexMatch = VERTEX_RE.exec(mesh)) !== null) {
      positionsList.push(
        Number.parseFloat(vertexMatch[1] ?? '0'),
        Number.parseFloat(vertexMatch[2] ?? '0'),
        Number.parseFloat(vertexMatch[3] ?? '0')
      )
    }
    const vertexCount = positionsList.length / 3
    if (vertexCount === 0) continue

    const indexList: number[] = []
    const supportPaint: MeshPaintCodes = {}
    const seamPaint: MeshPaintCodes = {}
    const colorPaint: MeshPaintCodes = {}
    TRIANGLE_RE.lastIndex = 0
    let triangleIndex = 0
    let triangleMatch: RegExpExecArray | null
    while ((triangleMatch = TRIANGLE_RE.exec(mesh)) !== null) {
      indexList.push(
        Number.parseInt(triangleMatch[1] ?? '0', 10),
        Number.parseInt(triangleMatch[2] ?? '0', 10),
        Number.parseInt(triangleMatch[3] ?? '0', 10)
      )
      const rest = triangleMatch[4] ?? ''
      // `paint` is rare relative to triangle count — only run the attribute regexes when present.
      if (rest.includes('paint_')) {
        const support = PAINT_SUPPORTS_RE.exec(rest)?.[1]
        if (support) supportPaint[triangleIndex] = support
        const seam = PAINT_SEAM_RE.exec(rest)?.[1]
        if (seam) seamPaint[triangleIndex] = seam
        const color = PAINT_COLOR_RE.exec(rest)?.[1]
        if (color) colorPaint[triangleIndex] = color
      }
      triangleIndex += 1
    }
    if (indexList.length === 0) continue

    const positions = new Float32Array(positionsList)
    const index = vertexCount > 65535 ? new Uint32Array(indexList) : new Uint16Array(indexList)
    results.push({ objectId, positions, index, supportPaint, seamPaint, colorPaint })
  }
  return results
}

/** Build the final processed geometry (weld -> crease -> planar-patch) from raw mesh arrays. */
export function buildGeometryFromArrays(data: ThreeMfMeshArrays): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(data.index, 1))
  const weldedGeometry = mergeVertices(geometry, THREE_MF_VERTEX_WELD_TOLERANCE)
  weldedGeometry.deleteAttribute('normal')
  const smoothedGeometry = toCreasedNormals(weldedGeometry, THREE_MF_SMOOTH_NORMAL_ANGLE)
  const correctedGeometry = flattenPlanarPatchNormals(smoothedGeometry)
  correctedGeometry.computeBoundingSphere()
  if (Object.keys(data.supportPaint).length > 0) correctedGeometry.userData.supportPaint = data.supportPaint
  if (Object.keys(data.seamPaint).length > 0) correctedGeometry.userData.seamPaint = data.seamPaint
  if (Object.keys(data.colorPaint).length > 0) correctedGeometry.userData.colorPaint = data.colorPaint
  return correctedGeometry
}

/** Parse a whole 3MF model entry into per-object processed geometry (DOM-free; worker + fallback). */
export function buildThreeMfGeometries(xmlText: string): Map<number, THREE.BufferGeometry> {
  const geometries = new Map<number, THREE.BufferGeometry>()
  for (const data of parseThreeMfMeshArrays(xmlText)) {
    geometries.set(data.objectId, buildGeometryFromArrays(data))
  }
  return geometries
}

/** Decode a binary/ASCII STL into a single processed geometry (used for import-backed meshes). */
export function buildStlGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
  const geometry = new STLLoader().parse(buffer)
  geometry.deleteAttribute('normal')
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Re-flatten coplanar triangle patches so large flat faces shade as one plane. Moved here (from
 * threeMfScene) so the worker and the main-thread fallback share one implementation. Pure math.
 */
export function flattenPlanarPatchNormals(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const nonIndexedGeometry = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  if (!nonIndexedGeometry.getAttribute('normal')) {
    nonIndexedGeometry.computeVertexNormals()
  }

  const positionAttribute = nonIndexedGeometry.getAttribute('position')
  const normalAttribute = nonIndexedGeometry.getAttribute('normal')
  if (!positionAttribute || !normalAttribute) {
    return nonIndexedGeometry
  }

  const triangleCount = Math.floor(positionAttribute.count / 3)
  const normals = new Float32Array(normalAttribute.array)
  const planarBuckets = new Map<string, { triangles: number[]; normal: THREE.Vector3 }>()
  const vertexA = new THREE.Vector3()
  const vertexB = new THREE.Vector3()
  const vertexC = new THREE.Vector3()
  const edgeAB = new THREE.Vector3()
  const edgeAC = new THREE.Vector3()
  const faceNormal = new THREE.Vector3()

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const offset = triangleIndex * 3
    vertexA.fromBufferAttribute(positionAttribute, offset)
    vertexB.fromBufferAttribute(positionAttribute, offset + 1)
    vertexC.fromBufferAttribute(positionAttribute, offset + 2)
    edgeAB.subVectors(vertexB, vertexA)
    edgeAC.subVectors(vertexC, vertexA)
    faceNormal.crossVectors(edgeAB, edgeAC)
    if (faceNormal.lengthSq() < 1e-10) continue
    faceNormal.normalize()

    const bucketKey = [
      Math.round(faceNormal.x * 250),
      Math.round(faceNormal.y * 250),
      Math.round(faceNormal.z * 250)
    ].join('|')
    const bucket = planarBuckets.get(bucketKey)
    if (bucket) {
      bucket.triangles.push(triangleIndex)
      bucket.normal.add(faceNormal)
    } else {
      planarBuckets.set(bucketKey, {
        triangles: [triangleIndex],
        normal: faceNormal.clone()
      })
    }
  }

  for (const bucket of planarBuckets.values()) {
    if (bucket.triangles.length < 2) continue
    const bucketNormal = bucket.normal.normalize()
    for (const triangleIndex of bucket.triangles) {
      const normalOffset = triangleIndex * 9
      for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
        normals[normalOffset + vertexIndex * 3] = bucketNormal.x
        normals[normalOffset + vertexIndex * 3 + 1] = bucketNormal.y
        normals[normalOffset + vertexIndex * 3 + 2] = bucketNormal.z
      }
    }
  }

  nonIndexedGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  return nonIndexedGeometry
}
