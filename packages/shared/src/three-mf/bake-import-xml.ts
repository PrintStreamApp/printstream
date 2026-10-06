/**
 * Render imported mesh, assembly, part-file, and model-settings XML for 3MF bakes.
 *
 * The builder in bake-documents.ts allocates ids and orders edit phases; these
 * functions only serialize the supplied objects and keep BambuStudio's single-
 * and multi-solid material metadata shapes aligned.
 */
import { isProcessSettingKey } from '../process-settings.js'
import { canonicalThreeMfPartSubtype } from '../three-mf-part-subtype.js'
import { parseAttrs } from './index-parser.js'
import type { ImportedMesh } from './imported-mesh.js'
import type { TrianglePaintAttribute } from './import-edit-index.js'
import { escapeXmlAttribute } from './xml-write.js'
import { formatThreeMfTransformValue, IDENTITY_THREE_MF_TRANSFORM, productionUuidAttr } from './bake-xml-format.js'

const THREE_MF_3DMODEL_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'

/**
 * Append a `<Relationship>` for each split-out import part file to the sub-model rels XML (or build a
 * fresh one when the source had none). Each part file MUST be declared here or BambuStudio won't load
 * it. Ids are derived from the part path so re-runs are stable and never collide with the source's.
 */
export function appendImportPartRelationships(baseRelsXml: string | null, partFiles: ImportedPartFileEntry[]): string {
  const relationships = partFiles.map((entry) => {
    const id = `rel-${entry.name.replace(/[^a-zA-Z0-9]+/g, '-')}`
    return `  <Relationship Target="/${entry.name}" Id="${id}" Type="${THREE_MF_3DMODEL_REL_TYPE}"/>`
  })
  if (baseRelsXml && /<\/Relationships>/.test(baseRelsXml)) {
    return baseRelsXml.replace(/<\/Relationships>/, `${relationships.join('\n')}\n</Relationships>`)
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...relationships,
    '</Relationships>'
  ].join('\n')
}

function formatMeshCoordinate(value: number): string {
  const rounded = Math.round(value * 1e5) / 1e5
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** Test seam for the import paint contract (see `mesh-import.test.ts`). */
export function renderImportedMeshObjectXmlForTest(objectId: number, mesh: ImportedMesh): string {
  return renderImportedMeshObjectXml(objectId, mesh, null)
}

/** Render an imported mesh as a self-contained `<object><mesh>` with optional triangle paint. */
export function renderImportedMeshObjectXml(
  objectId: number,
  mesh: ImportedMesh,
  genUuid: (() => string) | null,
  /**
   * Triangle paint for this mesh, by channel attribute and triangle index. Indices are positions
   * in `mesh.indices`, the SAME order the editor rendered through `meshToBinaryStl`, which is
   * what makes painting an unsaved import safe (contract pinned in `mesh-import.test.ts`).
   */
  paint?: ReadonlyMap<TrianglePaintAttribute, Record<string, string>>
): string {
  const vertices: string[] = []
  for (let i = 0; i < mesh.positions.length; i += 3) {
    vertices.push(`     <vertex x="${formatMeshCoordinate(mesh.positions[i] ?? 0)}" y="${formatMeshCoordinate(mesh.positions[i + 1] ?? 0)}" z="${formatMeshCoordinate(mesh.positions[i + 2] ?? 0)}"/>`)
  }
  const triangles: string[] = []
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const triangleIndex = i / 3
    let attrs = ''
    if (paint) {
      for (const [attribute, codes] of paint) {
        const code = codes[String(triangleIndex)]
        if (code) attrs += ` ${attribute}="${escapeXmlAttribute(code)}"`
      }
    }
    triangles.push(`     <triangle v1="${mesh.indices[i] ?? 0}" v2="${mesh.indices[i + 1] ?? 0}" v3="${mesh.indices[i + 2] ?? 0}"${attrs}/>`)
  }
  return [
    `  <object id="${objectId}"${productionUuidAttr(genUuid)} type="model">`,
    '   <mesh>',
    '    <vertices>',
    vertices.join('\n'),
    '    </vertices>',
    '    <triangles>',
    triangles.join('\n'),
    '    </triangles>',
    '   </mesh>',
    '  </object>'
  ].join('\n')
}

/** Replace only an object's mesh payload, retaining its id, UUID, type, and surrounding entry. */
export function replaceObjectMeshInModelXml(modelXml: string, objectId: number, mesh: ImportedMesh): string {
  const replacementMesh = /<mesh>[\s\S]*?<\/mesh>/.exec(renderImportedMeshObjectXml(objectId, mesh, null))?.[0]
  if (!replacementMesh) throw new Error('Unable to serialize a replacement volume mesh')
  let found = false
  const output = modelXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (block, attrs: string) => {
    if (Number.parseInt(parseAttrs(attrs).id ?? '', 10) !== objectId) return block
    if (!/<mesh>/.test(block)) throw new Error(`Part mesh replacement target ${objectId} is not a mesh object`)
    found = true
    return block.replace(/<mesh>[\s\S]*?<\/mesh>/, replacementMesh)
  })
  if (!found) throw new Error(`Part mesh replacement target ${objectId} was not found`)
  return output
}

/**
 * Render the matching `model_settings.config` `<object>` metadata for an imported mesh
 * object. `extruder` records the placing instance's filament at BOTH levels, exactly as
 * desktop BambuStudio writes it: the OBJECT-level entry is what the CLI slices by (a
 * part-level entry alone is ignored for an inline-mesh object, which silently printed the
 * object with filament 1, A/B-verified on a real project), and the part-level entry is
 * what keeps the part's material on reopen/preview.
 */
export function renderImportedModelSettingsObjectXml(objectId: number, name: string, extruder: number | null): string {
  return [
    `  <object id="${objectId}">`,
    `    <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...(extruder != null ? [`    <metadata key="extruder" value="${extruder}"/>`] : []),
    `    <part id="${objectId}" subtype="normal_part">`,
    `      <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...(extruder != null ? [`      <metadata key="extruder" value="${extruder}"/>`] : []),
    '    </part>',
    '  </object>'
  ].join('\n')
}

/**
 * Render a multi-solid import's ROOT object: a `<components>` object (no mesh of its own) that
 * references each solid's mesh object by an identity transform. This is the object a build item
 * places, so the whole assembly moves/clones as one, exactly how BambuStudio loads a multi-part
 * STEP. (3MF requires an object be mesh XOR components; the solids carry the meshes.)
 *
 * When `partPath` is set the solids live in a separate `/3D/Objects/…model` sub-model (the
 * Production-Extension "split" layout BambuStudio writes); each component then carries `p:path` so
 * the reader resolves the solid in that part file. When null the solids are inline in the root model
 * (same-file lookup): the fallback for non-production projects.
 */
export function renderImportedComponentsObjectXml(
  objectId: number,
  componentObjectIds: number[],
  genUuid: (() => string) | null,
  partPath: string | null = null,
  /**
   * Per-solid object-local placement, by the same index as `componentObjectIds`. An import's
   * per-solid meshes already share assembly space, so a solid the user never moved stays at
   * identity; `SceneEdit.importPartTransforms` supplies the rest (the gizmo on an import sub-part).
   */
  partTransforms?: ReadonlyMap<number, readonly number[]>
): string {
  const pathAttr = partPath ? ` p:path="${escapeXmlAttribute(partPath)}"` : ''
  return [
    `  <object id="${objectId}"${productionUuidAttr(genUuid)} type="model">`,
    '   <components>',
    ...componentObjectIds.map((id, index) => {
      const matrix = partTransforms?.get(index)
      const transform = matrix ? matrix.map(formatThreeMfTransformValue).join(' ') : IDENTITY_THREE_MF_TRANSFORM
      return `    <component${pathAttr} objectid="${id}"${productionUuidAttr(genUuid)} transform="${transform}"/>`
    }),
    '   </components>',
    '  </object>'
  ].join('\n')
}

/**
 * Wrap imported solid mesh objects in a standalone Production-Extension sub-model
 * (`/3D/Objects/…model`). BambuStudio splits every object into its own such part file and references
 * it via `p:path`; emitting large imported meshes here (instead of inline in the 13MB root model)
 * lets the editor fetch/parse only the objects a plate actually shows, and produces a byte-layout
 * that matches BambuStudio's own. Mirrors the header BS writes (confirmed to open in the GUI).
 */
export function renderImportedPartFileModel(meshObjectXmls: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ' <resources>',
    ...meshObjectXmls,
    ' </resources>',
    ' <build/>',
    '</model>',
    ''
  ].join('\n')
}

/** A sub-model part file produced for a split-out import, plus its `3D/_rels` relationship target. */
export interface ImportedPartFileEntry {
  /** ZIP entry path, e.g. `3D/Objects/printstream_object_157.model` (no leading slash). */
  name: string
  content: string
}

/**
 * Render the `model_settings.config` entry for a multi-solid import: one `<part subtype="normal_part">`
 * per solid (keyed by its component object id, named, carrying the placing instance's filament as
 * `extruder` so every part keeps a material). Mirrors {@link renderImportedModelSettingsObjectXml}
 * for the single-mesh case, including the OBJECT-level `extruder`: the entry the CLI slices by;
 * the per-part entries alone are not honored.
 */
export function renderImportedMultiPartModelSettingsXml(
  objectId: number,
  name: string,
  objectExtruder: number | null,
  parts: Array<{ componentObjectId: number; name: string; extruder: number | null; processOverrides?: Record<string, string | string[]>; subtype?: string }>
): string {
  return [
    `  <object id="${objectId}">`,
    `    <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...(objectExtruder != null ? [`    <metadata key="extruder" value="${objectExtruder}"/>`] : []),
    ...parts.flatMap((part) => [
      // Canonicalised, never written raw. `ModelVolume::type_from_string` is an exact match on five
      // strings and DEFAULTS TO MODEL_PART for anything else (`Model.cpp:3400-3416`), so a stray
      // `ParameterModifier` does not fail, it prints the modifier as solid geometry. Nothing
      // observed produces a non-canonical value today; this is the rule `three-mf-part-subtype.ts`
      // already states, applied at the one place that writes the attribute.
      `    <part id="${part.componentObjectId}" subtype="${escapeXmlAttribute(canonicalThreeMfPartSubtype(part.subtype))}">`,
      `      <metadata key="name" value="${escapeXmlAttribute(part.name)}"/>`,
      ...(part.extruder != null ? [`      <metadata key="extruder" value="${part.extruder}"/>`] : []),
      // Per-part process overrides set on the unsaved import, baked into the part's metadata
      // (process-setting keys only: structural keys must not be forgeable through this map).
      ...Object.entries(part.processOverrides ?? {}).filter(([key]) => isProcessSettingKey(key)).map(([key, value]) =>
        `      <metadata key="${escapeXmlAttribute(key)}" value="${escapeXmlAttribute(Array.isArray(value) ? value.join(';') : value)}"/>`),
      '    </part>'
    ]),
    '  </object>'
  ].join('\n')
}
