/**
 * Writing a plain 3MF that carries several SOLIDS, as the transport for geometry the editor
 * produced itself.
 *
 * WHY THIS EXISTS. A staged import may hold many named solids ({@link StagedImport}'s `parts`), and
 * everything downstream already handles that: the bake writes them as `<component>` parts of ONE
 * object, the editor renders and transforms them per solid, and the materials/subtype seams address
 * them by index. But the only way to GET a multi-solid import was to hand a STEP assembly to the
 * server's tessellator: every editor-made geometry (a cut half, a split shell, a primitive) goes
 * out as a single-solid binary STL, which the format cannot express more than one of.
 *
 * So "split this object into parts" had nowhere to put its shells. Rather than grow the staging
 * endpoint a second request shape, or a second in-memory representation on each store, the shells
 * are written into the one multi-solid container BOTH stores already accept: a 3MF.
 *
 * PAIRED WITH `mesh-extract.ts`, deliberately in the same directory, because this is the write half
 * of that read. It leans on the extractor's documented fallback for a VANILLA 3MF (one with no
 * Bambu `Metadata/model_settings.config`): every build item is extracted as its own part, named
 * from the `<object name>` attribute. Nothing here writes project metadata, and it must not start:
 * the moment this file emits a `model_settings.config`, the extractor takes its Bambu path instead
 * and the fallback this depends on stops running. `mesh-archive.test.ts` pins the round trip.
 *
 * Coordinates are passed through UNTOUCHED. The solids arrive in one shared space (they were one
 * mesh a moment ago) and must stay in it, or a split assembly reassembles wrong; whether the group
 * as a whole is re-centred is the STAGING step's business (`ImportNormalization`), which sees all
 * the solids at once and so can move them together.
 */
import { escapeXmlAttribute } from './xml-write.js'

/** One solid to write: a name and its triangles as flat world coordinates (9 numbers per triangle). */
export interface ThreeMfArchiveSolid {
  name: string
  /** Flat triangle vertices: x,y,z per corner, 3 corners per triangle. */
  triangles: ArrayLike<number>
}

/** An archive as entry path → UTF-8 text. The caller owns zipping; this package has no ZIP layer. */
export type ThreeMfArchiveEntries = Record<string, string>

const CONTENT_TYPES_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
  '</Types>'
].join('\n')

const RELS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
  '</Relationships>'
].join('\n')

/** 3MF wants plain decimals; `toFixed` also kills exponent notation on very small coordinates. */
function coordinate(value: number): string {
  const rounded = Number(value.toFixed(6))
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/**
 * Build a vanilla (non-Bambu) 3MF holding one object per solid, each placed by an identity build
 * item so the extractor reads them back as one part apiece.
 *
 * Solids with fewer than three coordinates, or a triangle count that is not whole, are skipped
 * rather than written as a malformed mesh; a call left with nothing to write throws, because an
 * empty archive would stage as an import with no geometry and fail later with a worse message.
 */
export function buildVanillaThreeMfEntries(solids: ReadonlyArray<ThreeMfArchiveSolid>): ThreeMfArchiveEntries {
  const objects: string[] = []
  const items: string[] = []
  let objectId = 1

  for (const solid of solids) {
    const count = solid.triangles.length
    if (count < 9 || count % 9 !== 0) continue

    const vertices: string[] = []
    const triangles: string[] = []
    for (let index = 0; index < count; index += 3) {
      vertices.push(`     <vertex x="${coordinate(solid.triangles[index]!)}" y="${coordinate(solid.triangles[index + 1]!)}" z="${coordinate(solid.triangles[index + 2]!)}"/>`)
    }
    // One vertex per corner, unwelded: the extractor re-indexes anyway, and welding here would
    // change the triangle ORDER, which the paint contract depends on staying stable.
    for (let corner = 0; corner < count / 3; corner += 3) {
      triangles.push(`     <triangle v1="${corner}" v2="${corner + 1}" v3="${corner + 2}"/>`)
    }

    objects.push([
      `  <object id="${objectId}" type="model" name="${escapeXmlAttribute(solid.name)}">`,
      '   <mesh>',
      '    <vertices>',
      ...vertices,
      '    </vertices>',
      '    <triangles>',
      ...triangles,
      '    </triangles>',
      '   </mesh>',
      '  </object>'
    ].join('\n'))
    items.push(`  <item objectid="${objectId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`)
    objectId += 1
  }

  if (objects.length === 0) throw new Error('No solid had usable geometry to write.')

  const modelXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ' <resources>',
    ...objects,
    ' </resources>',
    ' <build>',
    ...items,
    ' </build>',
    '</model>'
  ].join('\n')

  return {
    '[Content_Types].xml': CONTENT_TYPES_XML,
    '_rels/.rels': RELS_XML,
    '3D/3dmodel.model': modelXml
  }
}
