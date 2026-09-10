/**
 * The generic (vanilla) 3MF export.
 *
 * Asserted by ROUND TRIP through `extractThreeMfImportMesh` rather than against the XML, because the
 * thing that has to hold is that another tool reading the core spec gets the objects back -- and our
 * own extractor's vanilla-3MF fallback reads exactly the core spec. Checking the markup instead
 * would pass for a file nothing can open.
 *
 * The two properties worth pinning are the ones an object-per-file format cannot express and this
 * one can: several NAMED solids in a single archive, and their RELATIVE placement.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { unzipSync, strFromU8 } from 'fflate'
import { extractThreeMfImportMesh, type ThreeMfImportSource } from '@printstream/shared/three-mf'
import { buildGenericThreeMf, genericThreeMfExportFileName } from './genericThreeMfExport'

/** A unit-cube mesh (12 triangles) at the given position, optionally tagged. */
function cubeMesh(position: [number, number, number], userData: Record<string, unknown> = {}): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  mesh.position.set(...position)
  Object.assign(mesh.userData, userData)
  return mesh
}

function groupWith(...meshes: THREE.Mesh[]): THREE.Group {
  const group = new THREE.Group()
  for (const mesh of meshes) group.add(mesh)
  return group
}

/**
 * Read the exported archive back through the same extractor an import would use.
 *
 * `readScene` throws and `readPlateIndexes` is empty deliberately: that is what a VANILLA 3MF looks
 * like to the extractor, and it is the path this export has to keep landing on. If a future change
 * made the archive look like a Bambu project, this helper would fail loudly rather than silently
 * collapsing the solids into one part.
 */
async function reimport(bytes: Uint8Array) {
  const entries = unzipSync(bytes)
  const source: ThreeMfImportSource = {
    readEntryText: async (entryPath) => (entries[entryPath] ? strFromU8(entries[entryPath]) : null),
    readPlateIndexes: async () => [],
    readScene: async () => { throw new Error('a vanilla 3MF has no scene to read') }
  }
  return await extractThreeMfImportMesh(source)
}

test('several objects become several named solids in ONE archive', async () => {
  // The whole reason this export exists beside the STL one: STL can merge them anonymously or write
  // N files, and neither keeps a multi-object plate together with its names.
  const bytes = await buildGenericThreeMf([
    { name: 'Bracket', group: groupWith(cubeMesh([0, 0, 0])) },
    { name: 'Cover', group: groupWith(cubeMesh([10, 0, 0])) }
  ])
  assert.ok(bytes)
  const mesh = await reimport(bytes)
  assert.equal(mesh.parts?.length, 2)
  assert.deepEqual(mesh.parts?.map((part) => part.name), ['Bracket', 'Cover'])
})

test('objects keep their relative placement, re-centred as a whole', async () => {
  // Rebasing each solid to its own centre would stack them on the origin: the models would be
  // individually correct and the arrangement destroyed, which is silent in a file listing.
  const bytes = await buildGenericThreeMf([
    { name: 'Left', group: groupWith(cubeMesh([0, 0, 0])) },
    { name: 'Right', group: groupWith(cubeMesh([20, 0, 0])) }
  ])
  assert.ok(bytes)
  const mesh = await reimport(bytes)
  // Two unit cubes 20mm apart span 21mm corner to corner however the pair is re-centred.
  assert.ok(Math.abs((mesh.bounds.max.x - mesh.bounds.min.x) - 21) < 1e-3,
    `expected a 21mm span, got ${mesh.bounds.max.x - mesh.bounds.min.x}`)
})

test('helper volumes are excluded, exactly as the STL export excludes them', async () => {
  // There is no client-side mesh boolean, so a negative part written as solid geometry would be
  // wrong rather than merely lossy.
  const bytes = await buildGenericThreeMf([
    { name: 'Body', group: groupWith(cubeMesh([0, 0, 0]), cubeMesh([3, 0, 0], { isHelperVolume: true })) }
  ])
  assert.ok(bytes)
  const mesh = await reimport(bytes)
  assert.equal(mesh.indices.length / 3, 12, 'only the printed cube survives')
})

test('a selection with no printed geometry returns null rather than an empty archive', async () => {
  const bytes = await buildGenericThreeMf([
    { name: 'Modifier only', group: groupWith(cubeMesh([0, 0, 0], { isHelperVolume: true })) }
  ])
  assert.equal(bytes, null)
})

test('the archive carries no Bambu metadata, which is what makes it generic', async () => {
  // BambuStudio's own "Export Generic 3MF" still writes `model_settings.config` and
  // `project_settings.config` -- it only drops the production extension. A file carrying project
  // metadata is not what someone exporting FOR ANOTHER SLICER asked for.
  const bytes = await buildGenericThreeMf([{ name: 'Part', group: groupWith(cubeMesh([0, 0, 0])) }])
  assert.ok(bytes)
  const names = Object.keys(unzipSync(bytes))
  assert.deepEqual(names.sort(), ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'].sort())
  const model = strFromU8(unzipSync(bytes)['3D/3dmodel.model']!)
  assert.ok(model.includes('unit="millimeter"'), 'the core spec declares its units')
  assert.ok(!model.includes('BambuStudio'), 'no vendor namespace')
})

test('the file name never doubles its extension', () => {
  // An object read in from `bracket.3mf` must not export as `bracket.3mf.3mf`.
  assert.equal(genericThreeMfExportFileName('bracket'), 'bracket.3mf')
  assert.equal(genericThreeMfExportFileName('bracket.3mf'), 'bracket.3mf')
  assert.equal(genericThreeMfExportFileName('   '), 'object.3mf')
})
