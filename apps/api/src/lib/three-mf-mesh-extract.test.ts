import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import yazl from 'yazl'
import { extractThreeMfImportMesh } from './three-mf-mesh-extract.js'

async function writeZipFixture(filePath: string, entries: Array<[string, string]>): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const [entryPath, content] of entries) {
    zip.addBuffer(Buffer.from(content, 'utf8'), entryPath)
  }
  await new Promise<void>((resolve, reject) => {
    zip.outputStream
      .pipe(createWriteStream(filePath))
      .on('close', resolve)
      .on('error', reject)
    zip.end()
  })
}

/** One right triangle at the origin (0..10 in x/y), inline in an `<object>`. */
function inlineMeshObject(id: number): string {
  return [
    `    <object id="${id}" type="model">`,
    '      <mesh>',
    '        <vertices>',
    '          <vertex x="0" y="0" z="0"/>',
    '          <vertex x="10" y="0" z="0"/>',
    '          <vertex x="0" y="10" z="0"/>',
    '        </vertices>',
    '        <triangles>',
    '          <triangle v1="0" v2="1" v3="2"/>',
    '        </triangles>',
    '      </mesh>',
    '    </object>'
  ].join('\n')
}

const BAMBU_ROOT_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  '  <resources>',
  inlineMeshObject(3),
  inlineMeshObject(11),
  inlineMeshObject(19),
  '  </resources>',
  '  <build>',
  '    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 -40 0 0" printable="1"/>',
  '    <item objectid="11" transform="1 0 0 0 1 0 0 0 1 40 0 0" printable="1"/>',
  '    <item objectid="19" transform="1 0 0 0 1 0 0 0 1 0 60 0" printable="1"/>',
  '  </build>',
  '</model>'
].join('\n')

// Part ids match the (self-referential) component object ids of the inline-mesh objects.
const BAMBU_MODEL_SETTINGS_XML = [
  '<config>',
  '  <object id="3">',
  '    <metadata key="name" value="Box"/>',
  '    <part id="3" subtype="normal_part"><metadata key="name" value="Box"/></part>',
  '  </object>',
  '  <object id="11">',
  '    <metadata key="name" value="Lid"/>',
  '    <part id="11" subtype="normal_part"><metadata key="name" value="Lid"/></part>',
  '  </object>',
  '  <object id="19">',
  '    <metadata key="name" value="Blocker"/>',
  '    <part id="19" subtype="support_blocker"><metadata key="name" value="Blocker"/></part>',
  '  </object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="153"/></model_instance>',
  '    <model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="204"/></model_instance>',
  '    <model_instance><metadata key="object_id" value="19"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="255"/></model_instance>',
  '  </plate>',
  '</config>'
].join('\n')

async function withFixture(
  entries: Array<[string, string]>,
  run: (filePath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'three-mf-extract-'))
  const filePath = path.join(tempDir, 'fixture.3mf')
  try {
    await writeZipFixture(filePath, entries)
    await run(filePath)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

test('extracts a Bambu 3MF plate as one part per printed object, placements preserved', async () => {
  await withFixture([
    ['3D/3dmodel.model', BAMBU_ROOT_MODEL_XML],
    ['Metadata/model_settings.config', BAMBU_MODEL_SETTINGS_XML]
  ], async (filePath) => {
    const mesh = await extractThreeMfImportMesh(filePath)
    assert.ok(mesh.parts, 'multi-object plate should carry parts')
    // Helper volumes ride along, keeping their type — BambuStudio's Import Object loads a 3MF's
    // ModelVolumes whole (only the config is dropped), so a blocker must survive the round-trip.
    assert.deepEqual(mesh.parts!.map((part) => part.name), ['Box', 'Lid', 'Blocker'])
    // Raw 3MF strings, carried verbatim (Bambu marks ordinary parts `normal_part`) — consumers
    // classify through canonicalThreeMfPartSubtype rather than testing truthiness.
    assert.deepEqual(mesh.parts!.map((part) => part.subtype ?? null), ['normal_part', 'normal_part', 'support_blocker'])
    // ...but the MERGED mesh is printed geometry only: it feeds bounds, the triangle count, and
    // the thumbnail, none of which may show or be inflated by an aid.
    assert.equal(mesh.indices.length / 3, 2)
    // Build transforms are baked into the vertices: the two triangles sit 80mm apart in x.
    const box = mesh.parts![0]!.mesh
    const lid = mesh.parts![1]!.mesh
    assert.equal(lid.bounds.min.x - box.bounds.min.x, 80)
    // The merged bounds cover both PRINTED parts, re-centred as a group on the XY origin at Z=0.
    assert.equal(mesh.bounds.max.x - mesh.bounds.min.x, 90)
    assert.equal(mesh.bounds.min.x, -45)
    assert.equal(mesh.bounds.min.x + mesh.bounds.max.x, 0)
    assert.equal(mesh.bounds.min.z, 0)
    // The blocker sits at y=60 in the source; re-centring is measured on the printed parts alone,
    // so it keeps its offset relative to them instead of dragging the model off-centre.
    const blocker = mesh.parts![2]!.mesh
    assert.equal(blocker.bounds.min.y - box.bounds.min.y, 60)
  })
})

test('extracts a single object (objectId) in object-local coordinates', async () => {
  await withFixture([
    ['3D/3dmodel.model', BAMBU_ROOT_MODEL_XML],
    ['Metadata/model_settings.config', BAMBU_MODEL_SETTINGS_XML]
  ], async (filePath) => {
    const mesh = await extractThreeMfImportMesh(filePath, { objectId: 11 })
    // One part → merged mesh only (the STEP single-solid rule).
    assert.equal(mesh.parts, undefined)
    assert.equal(mesh.indices.length / 3, 1)
    // No build placement, and the 0..10 authored footprint re-centres on the origin.
    assert.equal(mesh.bounds.min.x, -5)
    assert.equal(mesh.bounds.max.x, 5)
  })
})

test('falls back to the root build parse for a vanilla 3MF (no Bambu metadata)', async () => {
  const vanillaXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    '  <resources>',
    '    <object id="1" name="Widget" type="model">',
    '      <mesh>',
    '        <vertices>',
    '          <vertex x="0" y="0" z="0"/>',
    '          <vertex x="10" y="0" z="0"/>',
    '          <vertex x="0" y="10" z="0"/>',
    '        </vertices>',
    '        <triangles>',
    '          <triangle v1="0" v2="1" v3="2"/>',
    '        </triangles>',
    '      </mesh>',
    '    </object>',
    '  </resources>',
    '  <build>',
    '    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 2"/>',
    '  </build>',
    '</model>'
  ].join('\n')
  await withFixture([['3D/3dmodel.model', vanillaXml]], async (filePath) => {
    const mesh = await extractThreeMfImportMesh(filePath)
    assert.equal(mesh.parts, undefined)
    // Build transform applied, then the group re-centres: width preserved, resting at Z=0.
    assert.equal(mesh.bounds.max.x - mesh.bounds.min.x, 10)
    assert.equal(mesh.bounds.min.x, -5)
    assert.equal(mesh.bounds.min.z, 0)
  })
})

test('resolves Bambu production files whose meshes live in sub-model entries', async () => {
  const rootXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
    '  <resources>',
    '    <object id="3" type="model"><components><component p:path="/3D/Objects/object_3.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 7"/></components></object>',
    '  </resources>',
    '  <build>',
    '    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 100 0 0" printable="1"/>',
    '  </build>',
    '</model>'
  ].join('\n')
  const subModelXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter">',
    '  <resources>',
    inlineMeshObject(1),
    '  </resources>',
    '</model>'
  ].join('\n')
  const modelSettings = [
    '<config>',
    '  <object id="3">',
    '    <metadata key="name" value="Widget"/>',
    '    <part id="1" subtype="normal_part"><metadata key="name" value="Widget"/></part>',
    '  </object>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="153"/></model_instance>',
    '  </plate>',
    '</config>'
  ].join('\n')
  await withFixture([
    ['3D/3dmodel.model', rootXml],
    ['3D/Objects/object_3.model', subModelXml],
    ['Metadata/model_settings.config', modelSettings]
  ], async (filePath) => {
    const mesh = await extractThreeMfImportMesh(filePath)
    // Component transform composes with the geometry (10mm width intact); the group
    // re-centres, so the component's z+7 lift floors back to Z=0.
    assert.equal(mesh.bounds.min.z, 0)
    assert.equal(mesh.bounds.max.x - mesh.bounds.min.x, 10)
  })
})

test('throws a user-facing error when the 3MF has no geometry', async () => {
  const emptyXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter"><resources/><build/></model>'
  ].join('\n')
  await withFixture([['3D/3dmodel.model', emptyXml]], async (filePath) => {
    await assert.rejects(
      () => extractThreeMfImportMesh(filePath),
      /no importable model geometry/
    )
  })
})

test('throws when the requested objectId does not exist', async () => {
  await withFixture([
    ['3D/3dmodel.model', BAMBU_ROOT_MODEL_XML],
    ['Metadata/model_settings.config', BAMBU_MODEL_SETTINGS_XML]
  ], async (filePath) => {
    await assert.rejects(
      () => extractThreeMfImportMesh(filePath, { objectId: 999 }),
      /not found in this 3MF/
    )
  })
})
