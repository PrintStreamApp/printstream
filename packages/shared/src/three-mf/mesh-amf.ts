/**
 * AMF (Additive Manufacturing Format) geometry import.
 *
 * OWNS turning an AMF document into an {@link ImportedMesh}. Shared for the same reason the STL and
 * OBJ parsers are: the api parses an upload and the browser parses a file the user picked for the
 * public editor, and the two must agree.
 *
 * SHAPE OF THE FORMAT, and why it maps onto `parts`. An AMF `<object>` holds ONE `<mesh>` whose
 * `<vertices>` are a single shared pool, and one or more `<volume>` elements that index into it
 * (`Format/AMF.cpp:141-153`). A volume is a distinct solid of the same object -- which is precisely
 * what {@link ImportedMesh.parts} already means for a multi-solid STEP assembly, so an AMF reuses
 * that machinery rather than growing its own. Volumes across SEVERAL `<object>` elements flatten
 * into one part list, because a staged import is one object; their coordinates already share a
 * space, so flattening cannot move anything.
 *
 * ZIP IS THE CALLER'S PROBLEM. An `.amf` may be raw XML or a ZIP containing one
 * (`load_amf:1111` switches on a `PK` magic), and this package has no ZIP layer by design -- the api
 * unzips with yauzl and the browser with fflate, exactly as they already do either side of
 * `mesh-extract.ts`. {@link isZippedAmf} is the shared sniff so both hosts branch on one rule.
 *
 * ONE DELIBERATE DIVERGENCE, and it is a fix rather than a preference. BambuStudio honours only
 * `unit="inch"` and ignores the other four the AMF spec allows (`:280-281`), so a document in metres
 * opens there a thousand times too small. We honour the full set via `MODEL_UNIT_MILLIMETRES`. This
 * is the same reasoning `model-unit.ts` gives for the 3MF `<model unit>` attribute: silently wrong
 * scale is not an error the user is shown, it is a model they have to notice.
 *
 * NOT HANDLED: per-volume materials. Materials belong with the colour-import work rather than with
 * geometry. Constellations are refused explicitly: ignoring their instances would silently remove
 * copies and placement transforms from otherwise valid geometry.
 */
import { assertImportTriangleBudget, computeMeshBounds, mergeImportedMeshes, weldImportedMeshVertices } from './mesh-stl.js'
import { MODEL_UNIT_MILLIMETRES } from './model-unit.js'
import { ModelImportError } from './imported-mesh.js'
import type { ImportedMesh, ImportedMeshPart } from './imported-mesh.js'

/**
 * Millimetres per AMF unit. `MODEL_UNIT_MILLIMETRES` covers the 3MF spelling of the same six units;
 * AMF writes `feet` where 3MF writes `foot`, so that one alias is added rather than duplicating the
 * table and letting the two drift apart on the five they share.
 */
const AMF_UNIT_MILLIMETRES: Readonly<Record<string, number>> = { ...MODEL_UNIT_MILLIMETRES, feet: 304.8 }

/** Maximum XML bytes decoded in memory by either host. Parsing holds source plus mesh arrays. */
export const MAX_AMF_SOURCE_BYTES = 64 * 1024 * 1024

/** ZIP local-file-header magic, the discriminator `load_amf` uses to pick its reader. */
export function isZippedAmf(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

/**
 * Parse AMF XML into a mesh, with one part per `<volume>`.
 *
 * Takes text rather than bytes because a zipped AMF has already been through the caller's ZIP layer
 * by the time it gets here, and re-decoding is the caller's to avoid.
 *
 * Throws when the document yields no triangles or a triangle names a vertex outside its object's
 * pool. A bad index is refused rather than skipped: it means the file disagrees with itself about
 * how many vertices there are, and guessing which end is right would silently reshape the model.
 */
export function parseAmfMesh(source: string): ImportedMesh {
  // Comments are stripped ONCE, up front, and everything below reads the result.
  //
  // Both halves of this parser are regex/scan based, so markup inside a comment is otherwise
  // indistinguishable from real markup. Two ways that bites, and the first was live: a banner
  // comment mentioning the root element (`<!-- exported as <amf> by SomeCAD -->`) won the search
  // for the `<amf unit=...>` tag, so the declared unit was missed entirely and an inch-declared
  // part imported 25.4x too small -- silently, which is exactly the failure the header calls out.
  // The second is that a commented-out `<volume>` would otherwise be scanned as a real one.
  const xml = stripXmlComments(source)
  if (/<constellation\b/i.test(xml)) {
    throw new ModelImportError('AMF constellation instances are not supported')
  }
  const scale = amfUnitScale(xml)
  const parts: ImportedMeshPart[] = []
  let triangleCount = 0

  // A single forward scan over tags, mirroring the SAX reader BambuStudio drives with expat. A
  // block-per-element regex would be simpler to read but quadratic on a large mesh, and AMF is a
  // format people export half-million-triangle scans into.
  const tagPattern = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let match: RegExpExecArray | null
  let textStart = 0

  // Per-object state. `vertices` is the object's shared pool; volumes index into it.
  let vertices: number[] = []
  let objectName: string | null = null
  // Per-vertex and per-triangle accumulators, each flushed on its closing tag.
  let coordinate: { x?: number; y?: number; z?: number } = {}
  let corners: number[] = []
  // Per-volume state.
  let volumeIndices: number[] | null = null
  let volumeName: string | null = null
  let metadataType: string | null = null

  const text = (end: number): string => xml.slice(textStart, end).trim()

  while ((match = tagPattern.exec(xml)) !== null) {
    const closing = match[1] === '/'
    const name = match[2]!.toLowerCase()
    const selfClosing = match[4] === '/'
    const contents = text(match.index)
    textStart = tagPattern.lastIndex

    if (selfClosing) continue

    if (!closing) {
      switch (name) {
        case 'object':
          vertices = []
          objectName = null
          break
        case 'volume':
          volumeIndices = []
          volumeName = null
          break
        case 'vertex':
          coordinate = {}
          break
        case 'triangle':
          corners = []
          break
        case 'metadata':
          metadataType = /\btype\s*=\s*["']([^"']*)["']/.exec(match[3] ?? '')?.[1]?.toLowerCase() ?? null
          break
        default:
          break
      }
      continue
    }

    switch (name) {
      case 'x': case 'y': case 'z': {
        const value = Number.parseFloat(contents)
        if (Number.isFinite(value)) coordinate[name] = value * scale
        break
      }
      case 'vertex':
        // A vertex missing a component is taken as 0 on that axis, which is what an absent child
        // element means in AMF; only a NON-NUMERIC value would have been dropped above.
        vertices.push(coordinate.x ?? 0, coordinate.y ?? 0, coordinate.z ?? 0)
        break
      case 'v1': case 'v2': case 'v3': {
        const index = Number.parseInt(contents, 10)
        if (!Number.isFinite(index)) throw new ModelImportError('AMF contains an unreadable vertex index')
        corners.push(index)
        break
      }
      case 'triangle':
        if (volumeIndices == null) break
        // Refused, not dropped, for the same reason a bad INDEX is: a triangle that does not name
        // three vertices means the file disagrees with itself, and skipping it leaves a hole the
        // user cannot see in a mesh that then slices as an open shell. The OBJ parser refuses the
        // same shape ("polygons with less than 3 vertices"), and so does BambuStudio.
        if (corners.length !== 3) throw new ModelImportError('AMF contains a triangle with less than 3 vertices')
        for (const corner of corners) {
          if (corner < 0 || corner * 3 + 2 >= vertices.length) {
            throw new ModelImportError('AMF contains an invalid vertex index')
          }
          volumeIndices.push(corner)
        }
        triangleCount += 1
        assertImportTriangleBudget(triangleCount)
        break
      case 'metadata':
        // `<metadata type="name">` is how AMF names both an object and a volume; which one it is
        // depends on where it sits, and a volume is always the inner scope.
        if (metadataType === 'name' && contents.length > 0) {
          if (volumeIndices != null) volumeName = contents
          else objectName = contents
        }
        metadataType = null
        break
      case 'volume': {
        if (volumeIndices != null && volumeIndices.length > 0) {
          parts.push({
            name: volumeName ?? objectName ?? `Volume ${parts.length + 1}`,
            // Each volume carries the object's WHOLE vertex pool and its own indices. The weld at
            // the end of the merge drops whatever a volume does not reference, so the parts arrive
            // in one shared coordinate space (which a multi-solid import requires) without each one
            // having to be re-indexed here.
            mesh: meshFromPool(vertices, volumeIndices)
          })
        }
        volumeIndices = null
        volumeName = null
        break
      }
      default:
        break
    }
  }

  if (parts.length === 0) throw new ModelImportError('AMF contained no triangles')
  return mergeAmfParts(parts)
}

/**
 * Remove `<!-- ... -->` regions so neither the unit lookup nor the tag scan can read markup that is
 * commented out. An unterminated comment swallows the rest of the document, which is what an XML
 * reader does too: the alternative is treating its contents as live markup.
 */
function stripXmlComments(xml: string): string {
  if (!xml.includes('<!--')) return xml
  let out = ''
  let at = 0
  for (;;) {
    const start = xml.indexOf('<!--', at)
    if (start < 0) { out += xml.slice(at); break }
    out += xml.slice(at, start)
    const end = xml.indexOf('-->', start + 4)
    if (end < 0) break
    at = end + 3
  }
  return out
}

/** The `<amf unit>` scale factor, defaulting to millimetres for an absent or unrecognised unit. */
function amfUnitScale(xml: string): number {
  const openTag = /<amf\b[^>]*>/i.exec(xml)?.[0]
  if (!openTag) return 1
  const unit = /\bunit\s*=\s*["']([^"']*)["']/i.exec(openTag)?.[1]?.trim().toLowerCase()
  if (!unit) return 1
  return AMF_UNIT_MILLIMETRES[unit] ?? 1
}

/** Expand a volume's indices against its object's shared vertex pool into a standalone mesh. */
function meshFromPool(vertices: readonly number[], indices: readonly number[]): ImportedMesh {
  const positions: number[] = []
  const own: number[] = []
  for (const index of indices) {
    own.push(positions.length / 3)
    positions.push(vertices[index * 3]!, vertices[index * 3 + 1]!, vertices[index * 3 + 2]!)
  }
  return weldImportedMeshVertices({ positions, indices: own, bounds: computeMeshBounds(positions) })
}

/**
 * Fold the volumes into the merged mesh every import needs, keeping them as `parts` when there is
 * more than one. Single-volume files report no parts at all, matching what a single-solid STEP or an
 * STL produces, so the editor treats them as an ordinary one-mesh object rather than an assembly.
 */
function mergeAmfParts(parts: ImportedMeshPart[]): ImportedMesh {
  // `mergeImportedMeshes` rather than a local fold: it copies element by element, where the obvious
  // `positions.push(...part.mesh.positions)` passes every coordinate as a call ARGUMENT and blows
  // the stack somewhere around a hundred thousand of them -- i.e. on exactly the large scan an AMF
  // is most likely to be, and never on a test fixture.
  const merged = mergeImportedMeshes(parts.map((part) => part.mesh))
  return parts.length > 1 ? { ...merged, parts } : merged
}
