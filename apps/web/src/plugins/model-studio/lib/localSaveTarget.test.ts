import assert from 'node:assert/strict'
import test from 'node:test'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import type { SaveArrangedThreeMf } from '@printstream/shared'
import { createLocalSaveTarget } from './localSaveTarget'
import { createLocalImportStore } from './localImportStore'
import { openThreeMfArchive } from './threeMfArchive'
import type { LocalProjectFile } from './localProjectFile'

const MODEL_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter"><resources></resources><build></build></model>'

const BASE_PAYLOAD: SaveArrangedThreeMf = {
  baseFileId: null,
  baseVersionId: null,
  mode: 'newVersion',
  sceneEdit: { plates: [{ index: 1 }], instances: [] }
} as unknown as SaveArrangedThreeMf

async function sourceArchive() {
  const zip = zipSync({
    '3D/3dmodel.model': strToU8(MODEL_XML),
    'Metadata/model_settings.config': strToU8('<config></config>'),
    'Metadata/vendor.xml': strToU8('<keep/>')
  })
  return openThreeMfArchive(new Blob([new Uint8Array(zip)]))
}

/** A project file with a writable handle, recording what gets written back to it. */
function writableProject(name: string) {
  const writes: Uint8Array[] = []
  const file: LocalProjectFile = {
    name,
    blob: new Blob([]),
    saveInPlace: async (bytes) => { writes.push(bytes) }
  }
  return { file, writes }
}

test('saving writes the baked project back to the opened file', async () => {
  const archive = await sourceArchive()
  const project = writableProject('Bracket.3mf')
  const target = createLocalSaveTarget({
    archive: () => archive,
    importStore: createLocalImportStore(),
    projectFile: () => project.file,
    onProjectFileChanged: () => assert.fail('an in-place save must not re-pick a destination')
  })

  const saved = await target.persist(BASE_PAYLOAD)
  assert.deepEqual(saved, { id: 'Bracket.3mf', name: 'Bracket.3mf' })
  assert.equal(project.writes.length, 1)

  // What was written is a real 3MF that kept the entries the bake did not touch.
  const entries = unzipSync(project.writes[0]!)
  assert.ok(entries['3D/3dmodel.model'])
  assert.ok(entries['Metadata/vendor.xml'], 'unrelated entries survive a local save')
})

test('a local save is never library-backed, so the caller skips library bookkeeping', async () => {
  const target = createLocalSaveTarget({
    archive: () => null,
    importStore: createLocalImportStore(),
    projectFile: () => null,
    onProjectFileChanged: () => {}
  })
  assert.equal(target.isLibraryBacked, false)
})

test('per-object settings reach the saved file rather than being dropped', async () => {
  // These ride the save REQUEST, not the SceneEdit, so they are easy to lose on the way to the
  // bake — and losing them looks like a successful save until the next slice comes out wrong.
  const zip = zipSync({
    '3D/3dmodel.model': strToU8(MODEL_XML),
    'Metadata/model_settings.config': strToU8('<config><object id="3"><metadata key="name" value="Widget"/></object></config>')
  })
  const archive = await openThreeMfArchive(new Blob([new Uint8Array(zip)]))
  const project = writableProject('Bracket.3mf')
  const target = createLocalSaveTarget({
    archive: () => archive,
    importStore: createLocalImportStore(),
    projectFile: () => project.file,
    onProjectFileChanged: () => {}
  })

  await target.persist({
    ...BASE_PAYLOAD,
    // The object has to be PLACED for the bake to keep it: an edit with no instances regenerates
    // model_settings without it, and there is then nothing for an override to attach to.
    sceneEdit: {
      plates: [{ index: 1 }],
      instances: [{
        objectId: 3,
        plateIndex: 1,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 }
      }]
    },
    objectProcessOverrides: { 3: { sparse_infill_density: '80%' } }
  } as SaveArrangedThreeMf)

  const settings = strFromU8(unzipSync(project.writes[0]!)['Metadata/model_settings.config']!)
  assert.match(settings, /key="sparse_infill_density" value="80%"/)
  // Structural metadata is not collateral damage.
  assert.match(settings, /key="name" value="Widget"/)
})

test('exporting bakes without writing anything', async () => {
  const archive = await sourceArchive()
  const project = writableProject('Bracket.3mf')
  const target = createLocalSaveTarget({
    archive: () => archive,
    importStore: createLocalImportStore(),
    projectFile: () => project.file,
    onProjectFileChanged: () => {}
  })

  const bytes = await target.exportBytes(BASE_PAYLOAD)
  assert.ok(unzipSync(bytes)['3D/3dmodel.model'])
  assert.equal(project.writes.length, 0, 'an export must not touch the opened file')
})

test('Save writes back to the opened file; Save-as never silently overwrites it', async () => {
  const archive = await sourceArchive()
  const project = writableProject('Bracket.3mf')
  let pickedDestination = 0
  const target = createLocalSaveTarget({
    archive: () => archive,
    importStore: createLocalImportStore(),
    projectFile: () => project.file,
    onProjectFileChanged: () => { pickedDestination += 1 }
  })

  // Save (mode newVersion) goes straight back to the handle the user granted.
  await target.persist({ ...BASE_PAYLOAD, mode: 'newVersion' } as SaveArrangedThreeMf)
  assert.equal(project.writes.length, 1)
  assert.equal(pickedDestination, 0, 'no destination prompt for a plain save')

  // Save-as must ask, even with no new name supplied. Keying this off the NAME instead of the mode
  // made a nameless Save-as overwrite the original without asking.
  const chosen: Uint8Array[] = []
  const target2 = globalThis as Record<string, unknown>
  target2.showSaveFilePicker = async (options: { suggestedName?: string }) => ({
    name: options.suggestedName ?? 'Chosen.3mf',
    getFile: async () => new File([], 'Chosen.3mf'),
    createWritable: async () => ({
      write: async (data: Blob) => { chosen.push(new Uint8Array(await data.arrayBuffer())) },
      close: async () => {}
    })
  })
  try {
    const savedAs = await target.persist({ ...BASE_PAYLOAD, mode: 'saveAs' } as SaveArrangedThreeMf)
    assert.equal(project.writes.length, 1, 'save-as must not overwrite the opened file')
    assert.equal(chosen.length, 1, 'save-as went to the chosen destination')
    // The opened file's name is the suggestion, which beats anything the editor could derive.
    assert.equal(savedAs?.name, 'Bracket.3mf')
    assert.equal(pickedDestination, 1, 'the host adopts the new handle for later saves')
  } finally {
    delete target2.showSaveFilePicker
  }
})
