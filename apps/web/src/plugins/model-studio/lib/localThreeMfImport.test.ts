/**
 * Importing a 3MF's geometry in the tab.
 *
 * What a given file CONTRIBUTES — which plate, which parts, the re-centring, the helper-volume
 * rules — is decided by the shared extractor and covered by the api's suite against real archives
 * (`apps/api/src/lib/three-mf-mesh-extract.test.ts`). What only exists here is the browser's byte
 * source: that an in-tab archive answers the extractor's three questions the same way yauzl does,
 * including the vanilla-3MF path, which is selected by `readScene` THROWING rather than returning
 * an empty scene. Get that wrong and a plain CAD export imports as nothing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { extractThreeMfImportMesh } from '@printstream/shared/three-mf'
import { openThreeMfArchive } from './threeMfArchive'
import { extractThreeMfImportFromFile, threeMfArchiveImportSource } from './localThreeMfImport'

/** One unit cube, as a 3MF `<object>` with a build item placing it away from the origin. */
function cubeModelXml(): string {
  const vertices = [
    [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
    [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]
  ].map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')
  const faces: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]
  ]
  const triangles = faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter"><resources>',
    `<object id="1" type="model" name="Cube"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`,
    '</resources><build>',
    '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 120 90 0"/>',
    '</build></model>'
  ].join('')
}

function archiveBlob(entries: Record<string, string>): Blob {
  const zipped: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(entries)) zipped[name] = strToU8(content)
  return new Blob([new Uint8Array(zipSync(zipped))])
}

test('a vanilla 3MF (no Bambu metadata) imports its build items', async () => {
  // The fallback path: `readScene` must THROW here, not answer emptily, or nothing is extracted.
  const mesh = await extractThreeMfImportFromFile(archiveBlob({ '3D/3dmodel.model': cubeModelXml() }))
  assert.equal(mesh.indices.length / 3, 12, 'all twelve cube triangles')
  assert.equal(mesh.positions.length / 3, 8)
})

test('the import is re-centred on the origin, not left at its plate coordinates', async () => {
  // The build item above places the cube at (120, 90). An import that kept those coordinates would
  // land plate-offset-plus-spot — off the bed — because the editor positions imports near-origin.
  const mesh = await extractThreeMfImportFromFile(archiveBlob({ '3D/3dmodel.model': cubeModelXml() }))
  assert.ok(Math.abs((mesh.bounds.min.x + mesh.bounds.max.x) / 2) < 1e-6, 'centred in X')
  assert.ok(Math.abs((mesh.bounds.min.y + mesh.bounds.max.y) / 2) < 1e-6, 'centred in Y')
  assert.equal(mesh.bounds.min.z, 0, 'resting on the bed')
})

test('the archive source answers the extractor the way the api ZIP reader does', async () => {
  const archive = await openThreeMfArchive(archiveBlob({ '3D/3dmodel.model': cubeModelXml() }))
  const source = threeMfArchiveImportSource(archive)
  assert.ok((await source.readEntryText('3D/3dmodel.model'))?.includes('<model'))
  // Absent entries read as null rather than throwing — the extractor skips those parts.
  assert.equal(await source.readEntryText('3D/Objects/nope.model'), null)
  // No Bambu scene metadata: throwing is what selects the vanilla fallback.
  await assert.rejects(() => source.readScene(1))
})

test('a file with no importable geometry is refused, not imported as an empty mesh', async () => {
  const empty = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources></resources><build></build></model>'
  await assert.rejects(
    () => extractThreeMfImportFromFile(archiveBlob({ '3D/3dmodel.model': empty })),
    /no importable model geometry/
  )
})

test('an object-scoped extraction takes that object alone, in object-local coordinates', async () => {
  // The Replace flow: the target keeps its own placement, so the build transform must NOT apply.
  const archive = await openThreeMfArchive(archiveBlob({ '3D/3dmodel.model': cubeModelXml() }))
  const mesh = await extractThreeMfImportMesh(threeMfArchiveImportSource(archive), { objectId: 1 })
  assert.equal(mesh.indices.length / 3, 12)
  await assert.rejects(
    () => extractThreeMfImportMesh(threeMfArchiveImportSource(archive), { objectId: 999 }),
    /was not found/
  )
})
