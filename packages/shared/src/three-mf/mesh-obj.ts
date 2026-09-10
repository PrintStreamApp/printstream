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
 * NOT HANDLED, deliberately: `mtllib` face colours. The directive names a SIDECAR `.mtl` resolved
 * relative to the OBJ's own directory (`:59-63`), and both hosts import a single file -- an upload
 * has no directory and the browser picker yields one `File`. So the colours exist in a file we are
 * never given. In-file vertex colours (`v x y z r g b`) ARE parseable here and are deliberately not
 * read yet: nothing consumes them, and a record nothing reads back is worse than none. Both belong
 * with the colour-to-filament-painting work (issue #90's `ObjColorDialog` half), which is where the
 * quantiser that would turn either into `paint_color` codes lives.
 */
import { assertImportTriangleBudget, computeMeshBounds, weldImportedMeshVertices } from './mesh-stl.js'
import { ModelImportError } from './imported-mesh.js'
import type { ImportedMesh } from './imported-mesh.js'

/**
 * Parse OBJ text into a single welded mesh.
 *
 * Throws when the file yields no triangles, or when a face names fewer than three vertices or an
 * out-of-range vertex -- BambuStudio refuses both rather than repairing them, and so do we, because
 * the alternative is a model with a hole the user cannot see.
 */
export function parseObjMesh(bytes: Uint8Array): ImportedMesh {
  const text = new TextDecoder().decode(bytes)
  // Flat x,y,z triples in file order. OBJ vertex references are 1-based into this list, and may be
  // NEGATIVE, meaning "counting back from the most recent vertex" -- which is why the list has to be
  // built as it is read rather than gathered in a first pass.
  const vertices: number[] = []
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
      // Trailing r g b (vertex colours) are ignored: only the first three fields are the position.
      const x = Number.parseFloat(fields[1] ?? '')
      const y = Number.parseFloat(fields[2] ?? '')
      const z = Number.parseFloat(fields[3] ?? '')
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new ModelImportError('OBJ contained a vertex with unreadable coordinates')
      }
      vertices.push(x, y, z)
      continue
    }

    if (keyword !== 'f') continue

    // A face vertex is `v`, `v/vt`, `v//vn` or `v/vt/vn`; only the position index is geometry.
    const corners = fields.slice(1)
    if (corners.length < 3) {
      throw new ModelImportError('OBJ contains polygons with less than 3 vertices')
    }
    const resolved: number[] = []
    for (const corner of corners) {
      const slash = corner.indexOf('/')
      const reference = Number.parseInt(slash < 0 ? corner : corner.slice(0, slash), 10)
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
    }

    // Fan from the first corner, exactly as BambuStudio does. Correct for the convex faces OBJ
    // exporters emit; a concave n-gon would need real triangulation, and Studio does not do it either.
    triangleCount += resolved.length - 2
    assertImportTriangleBudget(triangleCount)
    for (let corner = 1; corner + 1 < resolved.length; corner += 1) {
      for (const index of [resolved[0]!, resolved[corner]!, resolved[corner + 1]!]) {
        indices.push(positions.length / 3)
        positions.push(vertices[index * 3]!, vertices[index * 3 + 1]!, vertices[index * 3 + 2]!)
      }
    }
  }

  if (indices.length === 0) throw new ModelImportError('OBJ contained no triangles')
  return weldImportedMeshVertices({ positions, indices, bounds: computeMeshBounds(positions) })
}
