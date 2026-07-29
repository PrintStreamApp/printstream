import assert from 'node:assert/strict'
import test from 'node:test'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import type { SaveArrangedThreeMf } from '@printstream/shared'
import { openClientThreeMfProject } from './clientThreeMfProject'
import { createLocalProjectSource } from './editorProjectSource'
import { createLocalImportStore } from './localImportStore'
import { createLocalSaveTarget } from './localSaveTarget'
import { editorMaterialsFromProjectFilaments } from './editorMaterials'
import type { LocalProjectFile } from './localProjectFile'

/**
 * The whole local path end to end — open a file, read it through the project source, save it back —
 * because the pieces each having tests did not stop the HOST from wiring them together wrongly.
 * The specific near-miss: passing no archive to the save target, which bakes a valid but empty 3MF
 * and silently discards every mesh in the user's project.
 */

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter"><resources>',
  '<object id="3" type="model"><mesh><vertices/><triangles/></mesh></object>',
  '</resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>'
].join('')

const MODEL_SETTINGS_XML = [
  '<config>',
  '<object id="3"><metadata key="name" value="Widget"/><metadata key="extruder" value="1"/></object>',
  '<plate><metadata key="plater_id" value="1"/>',
  '<model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
  '</plate></config>'
].join('')

const PROJECT_SETTINGS = JSON.stringify({
  filament_type: ['PLA'],
  filament_colour: ['#00FF00'],
  filament_settings_id: ['Bambu PLA Basic']
})

function projectBlob(): Blob {
  return new Blob([new Uint8Array(zipSync({
    '3D/3dmodel.model': strToU8(MODEL_XML),
    'Metadata/model_settings.config': strToU8(MODEL_SETTINGS_XML),
    'Metadata/project_settings.config': strToU8(PROJECT_SETTINGS),
    'Metadata/vendor_thing.xml': strToU8('<vendor keep="yes"/>')
  }))])
}

test('a locally opened project reads through the source the editor uses', async () => {
  const project = await openClientThreeMfProject(projectBlob() as File)
  try {
    const source = createLocalProjectSource(project)

    const index = await source.loadIndex()
    assert.equal(index.plates.length, 1)
    // The DTO mapping must have run: a raw cast of the parser's index leaves this undefined and
    // every plate silently renders without its thumbnail.
    assert.equal(typeof index.plates[0]!.hasThumbnail, 'boolean')

    const scene = await source.loadScene(1, null)
    assert.ok(scene, 'the plated scene parses locally')
    assert.equal(scene.instances.length, 1)

    const entry = await source.loadEntry('3D/3dmodel.model')
    assert.ok(entry.byteLength > 0, 'mesh entries come straight out of the archive')
  } finally {
    project.dispose()
  }
})

test('materials come from the project itself when there is no slice controller', async () => {
  const project = await openClientThreeMfProject(projectBlob() as File)
  try {
    const materials = editorMaterialsFromProjectFilaments(project.index.projectFilaments)
    assert.equal(materials.options.length, 1)
    assert.equal(materials.options[0]?.id, 1, 'slot ids stay 1-based project filament ids')
    assert.equal(materials.options[0]?.label, 'PLA')
  } finally {
    project.dispose()
  }
})

test('saving locally preserves the project rather than baking an empty one', async () => {
  const project = await openClientThreeMfProject(projectBlob() as File)
  try {
    const writes: Uint8Array[] = []
    const file: LocalProjectFile = {
      name: 'Widget.3mf',
      blob: new Blob([]),
      saveInPlace: async (bytes) => { writes.push(bytes) }
    }
    const target = createLocalSaveTarget({
      // Exactly what the host must pass. With null here the save "succeeds" and destroys the file.
      archive: () => project.archive,
      importStore: createLocalImportStore(),
      projectFile: () => file,
      onProjectFileChanged: () => {},
    filamentPresets: () => []
    })

    await target.persist({
      baseFileId: null,
      baseVersionId: null,
      mode: 'newVersion',
      sceneEdit: {
        plates: [{ index: 1 }],
        instances: [{
          objectId: 3,
          plateIndex: 1,
          position: { x: 10, y: 20, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 }
        }]
      }
    } as unknown as SaveArrangedThreeMf)

    const saved = unzipSync(writes[0]!)
    // The object's geometry and the entries we never touched both survive.
    assert.match(strFromU8(saved['3D/3dmodel.model']!), /objectid="3"/)
    assert.equal(strFromU8(saved['Metadata/vendor_thing.xml']!), '<vendor keep="yes"/>')
    assert.match(strFromU8(saved['Metadata/model_settings.config']!), /value="Widget"/)

    // And the saved file re-opens as a project, which is the real end-to-end assertion.
    const reopened = await openClientThreeMfProject(new Blob([new Uint8Array(writes[0]!)]) as File)
    try {
      assert.equal(reopened.index.plates.length, 1)
      assert.equal(reopened.sceneForPlate(1)?.instances.length, 1)
    } finally {
      reopened.dispose()
    }
  } finally {
    project.dispose()
  }
})
