/**
 * Route mesh paint and repair edits to the 3MF model entry that owns each mesh.
 * Bambu root objects may reference mesh objects in separate part entries, so root
 * ids cannot be used as mesh ids when updating paint or repair data.
 */
import type { SceneEditPartPaint } from '../slicing.js'
import { parseAttrs } from './index-parser.js'
import type { TrianglePaintAttribute } from './import-edit-index.js'
import { parseRootModelComponents } from './scene-parser.js'

/**
 * Rewrite one mesh object's `<triangle>` paint attribute inside a model entry's XML.
 * `codes` is the complete desired map (triangle index in mesh order -> hex code):
 * mapped triangles get the attribute set, unmapped triangles get it removed. Triangle
 * tags whose paint does not change are left byte-for-byte intact. Codes are
 * schema-validated hex strings, so direct attribute interpolation is safe.
 */
function applyTrianglePaintToObjectBlock(block: string, attribute: TrianglePaintAttribute, codes: Record<string, string>): string {
  let triangleIndex = -1
  const stripPattern = new RegExp(`\\s+${attribute}="[^"]*"`, 'g')
  return block.replace(/<triangle\b([^>]*?)(\/?)>/g, (full, attrs: string, selfClose: string) => {
    triangleIndex += 1
    const code = codes[String(triangleIndex)]
    const cleaned = attrs.replace(stripPattern, '')
    if (code == null) {
      return cleaned === attrs ? full : `<triangle${cleaned}${selfClose}>`
    }
    return `<triangle${cleaned} ${attribute}="${code}"${selfClose}>`
  })
}

/**
 * Apply per-mesh triangle paint for one channel to a model entry's XML. `paints` keys
 * are the mesh object ids WITHIN this entry (component object ids); objects without an
 * entry are untouched.
 */
export function applyTrianglePaintToModelEntry(
  xml: string,
  attribute: TrianglePaintAttribute,
  paints: Map<number, Record<string, string>>
): string {
  if (paints.size === 0) return xml
  return xml.replace(/<object\b([^>]*)>([\s\S]*?)<\/object>/g, (full, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const codes = Number.isInteger(objectId) ? paints.get(objectId) : undefined
    if (!codes) return full
    return applyTrianglePaintToObjectBlock(full, attribute, codes)
  })
}

/**
 * Map each `SceneEdit.repairedObjectIds` root object to the entry + mesh-carrying object ids that
 * actually hold its geometry: `entryPath -> {mesh objectId}`. Mirrors {@link resolvePartPaintByEntry},
 * a Bambu project keeps each object's mesh in its own `3D/Objects/*.model`, so the id the editor
 * marked is a root that references the real mesh objects through `<components>`. An object with an
 * inline mesh (no components: e.g. a from-scratch scaffold) carries its own id in the root entry.
 */
export function resolveRepairMeshesByEntry(baseModelXml: string, repairedObjectIds: readonly number[]): Map<string, Set<number>> {
  const byEntry = new Map<string, Set<number>>()
  const componentsByObjectId = parseRootModelComponents(baseModelXml)
  const add = (entryPath: string, objectId: number) => {
    const ids = byEntry.get(entryPath) ?? new Set<number>()
    ids.add(objectId)
    byEntry.set(entryPath, ids)
  }
  for (const objectId of repairedObjectIds) {
    const components = componentsByObjectId.get(objectId) ?? []
    if (components.length === 0) {
      add('3D/3dmodel.model', objectId)
      continue
    }
    for (const component of components) add(component.entryPath, component.objectId)
  }
  return byEntry
}

/**
 * Resolve each painted part to the model entry its mesh lives in:
 * `entryPath -> (mesh object id within that entry -> triangle paint map)`. Painted parts
 * that cannot be resolved against the base model (stale ids, import-backed parts) are
 * skipped so the source geometry stays untouched rather than mis-painted.
 */
export function resolvePartPaintByEntry(
  baseModelXml: string,
  partPaint: SceneEditPartPaint[]
): Map<string, Map<number, Record<string, string>>> {
  const byEntry = new Map<string, Map<number, Record<string, string>>>()
  const componentsByObjectId = parseRootModelComponents(baseModelXml)
  for (const paint of partPaint) {
    const component = componentsByObjectId
      .get(paint.objectId)
      ?.find((entry) => entry.objectId === paint.componentObjectId)
    if (!component) continue
    const byMesh = byEntry.get(component.entryPath) ?? new Map<number, Record<string, string>>()
    byMesh.set(component.objectId, paint.triangles)
    byEntry.set(component.entryPath, byMesh)
  }
  return byEntry
}
