import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { buildBuiltinSlicingPresetId, type SaveArrangedThreeMf, type SlicingPresetSummary } from '@printstream/shared'
import { createLocalSaveTarget } from './localSaveTarget'
import { createLocalImportStore } from './localImportStore'
import { openThreeMfArchive } from './threeMfArchive'
import type { LocalProjectFile } from './localProjectFile'

const MODEL_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter"><resources></resources><build></build></model>'

/**
 * The same model, but declaring object 3. A build item naming an object the model does not contain
 * is refused by the bake: it would leave the real objects unreferenced and strip them, and
 * BambuStudio aborts the parse on it. A fixture that PLACES an object has to declare it.
 */
const MODEL_XML_WITH_OBJECT_3 = MODEL_XML.replace(
  '<resources></resources>',
  '<resources><object id="3" type="model"><mesh><vertices/><triangles/></mesh></object></resources>'
)

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
    onProjectFileChanged: () => assert.fail('an in-place save must not re-pick a destination'),
    filamentPresets: () => []
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
    onProjectFileChanged: () => {},
    filamentPresets: () => []
  })
  assert.equal(target.isLibraryBacked, false)
})

test('per-object settings reach the saved file rather than being dropped', async () => {
  // These ride the save REQUEST, not the SceneEdit, so they are easy to lose on the way to the
  // bake, and losing them looks like a successful save until the next slice comes out wrong.
  const zip = zipSync({
    '3D/3dmodel.model': strToU8(MODEL_XML_WITH_OBJECT_3),
    'Metadata/model_settings.config': strToU8('<config><object id="3"><metadata key="name" value="Widget"/></object></config>')
  })
  const archive = await openThreeMfArchive(new Blob([new Uint8Array(zip)]))
  const project = writableProject('Bracket.3mf')
  const target = createLocalSaveTarget({
    archive: () => archive,
    importStore: createLocalImportStore(),
    projectFile: () => project.file,
    onProjectFileChanged: () => {},
    filamentPresets: () => []
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
    onProjectFileChanged: () => {},
    filamentPresets: () => []
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
    onProjectFileChanged: () => { pickedDestination += 1 },
    filamentPresets: () => []
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

// ---- Machine retarget ------------------------------------------------------
// The public editor's "save this project for a different printer". The bake preserves the project's
// EMBEDDED machine, so without this pass a printer switch was silently lost: the file saved, and
// reopening it showed the original printer again. The api runs the same rewrite over its own bake
// (`apps/api/src/lib/save-retarget.ts`); both go through the shared
// `applyMachineRetargetToProjectSettings`, so what is pinned here is the WIRING.

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const H2D_MACHINE_ID = buildBuiltinSlicingPresetId('machine', 'Bambu Lab H2D 0.4 nozzle')
const PLA_FOR_H2D_ID = buildBuiltinSlicingPresetId('filament', 'Bambu PLA Basic @BBL H2D')

/** A project already carrying an X1C machine and one filament slot, so a retarget has work to do. */
async function x1cProjectArchive() {
  const zip = zipSync({
    '3D/3dmodel.model': strToU8(MODEL_XML),
    'Metadata/model_settings.config': strToU8('<config></config>'),
    'Metadata/project_settings.config': strToU8(JSON.stringify({
      printer_model: 'X1C',
      printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
      nozzle_diameter: ['0.4'],
      filament_type: ['PLA'],
      filament_colour: ['#00FF00'],
      filament_settings_id: ['Bambu PLA Basic @BBL X1C']
    })),
    'Metadata/slice_info.config': strToU8(
      '<config>\n  <metadata key="printer_model_id" value="BL-P001"/>\n  <plate/>\n</config>'
    )
  })
  return openThreeMfArchive(new Blob([new Uint8Array(zip)]))
}

/** Answer the three anonymous resolve endpoints the retarget needs. */
function stubResolveFetch() {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/resolve-machine')) {
      return Response.json({
        config: { printer_model: 'H2D', nozzle_diameter: ['0.4', '0.4'], physical_extruder_map: ['1', '0'] },
        name: 'Bambu Lab H2D 0.4 nozzle'
      })
    }
    if (url.includes('/resolve-filament')) {
      return Response.json({ config: { pre_start_fan_time: ['2'] }, baseConfig: {}, overriddenKeys: [] })
    }
    return new Response('unexpected', { status: 404 })
  }) as typeof globalThis.fetch
  return calls
}

const H2D_RETARGET = {
  mode: 'manualProfile',
  printerProfileId: H2D_MACHINE_ID,
  printerModel: 'H2D',
  plateType: 'High Temp Plate',
  nozzleDiameters: ['0.4'],
  toolheads: [],
  processProfileId: '',
  filamentMappings: []
} as unknown as SaveArrangedThreeMf['retarget']

test('a printer switch is written into the saved project, not lost with the bake', async () => {
  const calls = stubResolveFetch()
  const archive = await x1cProjectArchive()
  const project = writableProject('Bracket.3mf')
  const target = createLocalSaveTarget({
    archive: () => archive,
    importStore: createLocalImportStore(),
    projectFile: () => project.file,
    onProjectFileChanged: () => {},
    filamentPresets: () => [
      { id: PLA_FOR_H2D_ID, source: 'builtin', kind: 'filament', name: 'Bambu PLA Basic @BBL H2D', printerModels: ['H2D'] }
    ] as unknown as SlicingPresetSummary[]
  })

  await target.persist({
    ...BASE_PAYLOAD,
    retarget: H2D_RETARGET,
    slicerTargetId: 'bambustudio-2-7-1-62'
  } as SaveArrangedThreeMf)

  const entries = unzipSync(project.writes[0]!)
  const settings = JSON.parse(strFromU8(entries['Metadata/project_settings.config']!)) as Record<string, unknown>
  assert.equal(settings.printer_model, 'H2D')
  assert.equal(settings.printer_settings_id, 'Bambu Lab H2D 0.4 nozzle')
  // The slot rebound onto the target machine's variant of the same family, so the old machine's
  // numeric columns do not ride along as phantom "changed vs preset" markers.
  assert.deepEqual(settings.filament_settings_id, ['Bambu PLA Basic @BBL H2D'])
  // The previous slice's printer identity is stale the moment the printer changes.
  assert.doesNotMatch(strFromU8(entries['Metadata/slice_info.config']!), /printer_model_id/)
  assert.ok(calls.some((url) => url.includes('/api/public/slicing/resolve-machine')), 'resolved anonymously')
})

test('an unresolvable machine leaves the project on its own printer rather than half-authored', async () => {
  // A retarget is an improvement pass on a save the user asked for: failing it must not fail the
  // save, and must not leave a project naming a machine whose settings never arrived.
  globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof globalThis.fetch
  const archive = await x1cProjectArchive()
  const project = writableProject('Bracket.3mf')
  const target = createLocalSaveTarget({
    archive: () => archive,
    importStore: createLocalImportStore(),
    projectFile: () => project.file,
    onProjectFileChanged: () => {},
    filamentPresets: () => []
  })

  await target.persist({ ...BASE_PAYLOAD, retarget: H2D_RETARGET, slicerTargetId: 't' } as SaveArrangedThreeMf)

  const settings = JSON.parse(
    strFromU8(unzipSync(project.writes[0]!)['Metadata/project_settings.config']!)
  ) as Record<string, unknown>
  assert.equal(settings.printer_model, 'X1C')
})

test('a single-object export is never retargeted', async () => {
  // An export is one object taken OUT of the project, not the project being saved for another
  // printer, and the api's export path does not retarget either.
  const calls = stubResolveFetch()
  const archive = await x1cProjectArchive()
  const target = createLocalSaveTarget({
    archive: () => archive,
    importStore: createLocalImportStore(),
    projectFile: () => null,
    onProjectFileChanged: () => {},
    filamentPresets: () => []
  })

  const bytes = await target.exportBytes({
    ...BASE_PAYLOAD,
    objectExport: true,
    retarget: H2D_RETARGET,
    slicerTargetId: 't'
  } as unknown as SaveArrangedThreeMf)

  const settings = JSON.parse(
    strFromU8(unzipSync(bytes)['Metadata/project_settings.config']!)
  ) as Record<string, unknown>
  assert.equal(settings.printer_model, 'X1C')
  assert.equal(calls.length, 0, 'an export resolves nothing')
})
