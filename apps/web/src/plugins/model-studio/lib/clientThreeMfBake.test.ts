import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import type { SceneEdit } from '@printstream/shared'
import { bakeClientThreeMf } from './clientThreeMfBake'
import { openThreeMfArchive } from './threeMfArchive'

/**
 * These cover the browser's half of the bake: the ZIP layer and the copy pass. What the output
 * CONTAINS is decided by the shared plan, which the api's 124-test bake suite already exercises;
 * what is unproven here is that applying that plan with fflate produces a valid, complete archive.
 */

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter"><resources></resources><build></build></model>'
].join('\n')

const MODEL_SETTINGS_XML = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>', '</config>'].join('\n')

const EMPTY_EDIT: SceneEdit = { plates: [{ index: 1 }], instances: [] }

/** A Blob over a synthetic 3MF, since `openThreeMfArchive` takes what a file picker hands it. */
function sourceArchive(extra: Record<string, string> = {}): Blob {
  const entries: Record<string, Uint8Array> = {
    '3D/3dmodel.model': strToU8(MODEL_XML),
    'Metadata/model_settings.config': strToU8(MODEL_SETTINGS_XML)
  }
  for (const [name, content] of Object.entries(extra)) entries[name] = strToU8(content)
  return new Blob([new Uint8Array(zipSync(entries))])
}

test('a from-scratch bake produces an archive the parser can open', async () => {
  const { bytes } = await bakeClientThreeMf(null, EMPTY_EDIT)
  const entries = unzipSync(bytes)

  // The four entries a 3MF needs to be a 3MF at all.
  assert.ok(entries['[Content_Types].xml'], 'content types')
  assert.ok(entries['_rels/.rels'], 'package relationships')
  assert.ok(entries['3D/3dmodel.model'], 'root model')
  assert.ok(entries['Metadata/model_settings.config'], 'model settings')

  // And it round-trips: the archive reader accepts what we just wrote.
  const reopened = await openThreeMfArchive(new Blob([new Uint8Array(bytes)]))
  assert.ok(reopened.entryText('3D/3dmodel.model')?.includes('<model'))
})

test('the copy pass carries through every entry the bake does not rewrite', async () => {
  // A 3MF holds far more than the editor models. Anything not transformed must survive verbatim,
  // or saving would quietly strip the parts of the project we do not understand.
  const vendorBlob = '<?xml version="1.0"?><vendor-thing keep="yes"/>'
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/vendor_specific.xml': vendorBlob,
    'Metadata/plate_1.png': 'not-really-a-png-but-opaque-bytes'
  }))

  const { bytes } = await bakeClientThreeMf(archive, EMPTY_EDIT)
  const entries = unzipSync(bytes)

  assert.equal(strFromU8(entries['Metadata/vendor_specific.xml']!), vendorBlob)
  assert.equal(strFromU8(entries['Metadata/plate_1.png']!), 'not-really-a-png-but-opaque-bytes')
  // The model itself is rewritten (the build section is regenerated), so it is present but need
  // not match byte-for-byte.
  assert.ok(entries['3D/3dmodel.model'])
})

test('bakeClientThreeMf reports the baked ids the caller needs to re-key overrides', async () => {
  const { result } = await bakeClientThreeMf(null, EMPTY_EDIT)
  assert.deepEqual(result.replacedObjectIds, [])
  assert.deepEqual(result.importObjectIds, [])
  assert.deepEqual(result.clonedObjectIds, [])
})

/** A one-pixel PNG, base64 as the wire carries it (the editor strips the `data:` prefix). */
const PNG_BASE64
  = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('the editor\'s plate previews are embedded, replacing whatever the base carried', async () => {
  // A save runs no slicer, so nothing else regenerates these. Dropping them leaves the file showing
  // the layout as it was BEFORE the edit, everywhere previews are read, with nothing saying so.
  const stale = 'STALE-PREVIEW-BYTES'
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/plate_1.png': stale,
    'Metadata/plate_1_small.png': stale
  }))
  const edit: SceneEdit = { ...EMPTY_EDIT, plateThumbnails: [{ plateIndex: 1, png: PNG_BASE64 }] }

  const { bytes } = await bakeClientThreeMf(archive, edit)
  const entries = unzipSync(bytes)

  assert.notEqual(strFromU8(entries['Metadata/plate_1.png']!), stale, 'full-size preview replaced')
  // Both entries take the SAME image: BambuStudio renders the small variant smaller rather than
  // expecting different pixels, and a second render would cost a frame for no visible difference.
  assert.deepEqual(entries['Metadata/plate_1_small.png'], entries['Metadata/plate_1.png'], 'small variant too')
})

test('a preview that names no plate, or carries no image, is skipped rather than written', async () => {
  // Rejected rather than repaired: an index that identifies no plate has no correct entry to go to,
  // and an empty PNG would replace a good preview with a broken entry, which every consumer reads
  // as a corrupt archive rather than as a missing thumbnail.
  const archive = await openThreeMfArchive(sourceArchive())
  const edit: SceneEdit = {
    ...EMPTY_EDIT,
    plateThumbnails: [{ plateIndex: 0, png: PNG_BASE64 }, { plateIndex: 2, png: '' }]
  }

  const { bytes } = await bakeClientThreeMf(archive, edit)
  const entries = unzipSync(bytes)

  assert.equal(entries['Metadata/plate_0.png'], undefined, 'no plate 0')
  assert.equal(entries['Metadata/plate_2.png'], undefined, 'no empty preview')
})

/**
 * A project settings entry naming one filament.
 *
 * `filament_colour` is the load-bearing key, not `filament_settings_id`: the machine's slot in the
 * parallel preset records is `filamentCount + 1`, and the count comes from the colours
 * (`machinePresetSlotIndexFor`). Without it the slot cannot be located and every machine write is
 * skipped, which is a test that passes while asserting nothing.
 */
function projectSettings(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    filament_colour: ['#00AE42'],
    filament_settings_id: ['Bambu PLA Basic'],
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
    ...extra
  })
}

test('machine overrides are applied to the settings the bake wrote', async () => {
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/project_settings.config': projectSettings()
  }))
  const { bytes } = await bakeClientThreeMf(archive, EMPTY_EDIT, [], {}, {
    machineSettingOverrides: {
      overrides: { machine_max_acceleration_x: ['5000', '5000'] },
      resolvePreset: async () => ({})
    }
  })

  const written = JSON.parse(strFromU8(unzipSync(bytes)['Metadata/project_settings.config']!))
  assert.deepEqual(written.machine_max_acceleration_x, ['5000', '5000'])
})

test('an empty override map over a project that records none resolves no preset at all', async () => {
  // The editor sends this map on EVERY save, empty included, because empty is how a reset is
  // expressed. Resolving eagerly would put a preset round trip on every ordinary save.
  let resolved = 0
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/project_settings.config': projectSettings()
  }))
  await bakeClientThreeMf(archive, EMPTY_EDIT, [], {}, {
    machineSettingOverrides: {
      overrides: {},
      resolvePreset: async () => { resolved += 1; return {} }
    }
  })

  assert.equal(resolved, 0, 'nothing asked for and nothing recorded means nothing to do')
})

test('a preset that will not resolve leaves the overrides recorded rather than failing the save', async () => {
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/project_settings.config': projectSettings()
  }))
  const { bytes } = await bakeClientThreeMf(archive, EMPTY_EDIT, [], {}, {
    machineSettingOverrides: {
      overrides: { machine_max_acceleration_x: ['5000', '5000'] },
      resolvePreset: async () => { throw new Error('offline') }
    }
  })

  // The save still produces a file: losing a printer override is recoverable, losing the save is not.
  const written = JSON.parse(strFromU8(unzipSync(bytes)['Metadata/project_settings.config']!))
  assert.deepEqual(written.machine_max_acceleration_x, ['5000', '5000'])
})

test('overrides are applied AFTER the retarget, so the preset cannot overwrite the user', async () => {
  // The ordering constraint, which is the failure that looks like the feature simply not working:
  // the retarget writes the resolved preset's values over the same keys the user just edited.
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/project_settings.config': projectSettings()
  }))
  const { bytes } = await bakeClientThreeMf(archive, EMPTY_EDIT, [], {}, {
    machineRetarget: async () => ({
      machineConfig: { machine_max_acceleration_x: ['1000', '1000'], printer_model: ['Bambu Lab P1S'] },
      printerSettingsId: 'Bambu Lab P1S 0.4 nozzle',
      printerModel: 'Bambu Lab P1S',
      processConfig: null,
      processSettingOverrides: {},
      filamentRebinds: null,
      nozzleDiameters: null
    }),
    machineSettingOverrides: {
      overrides: { machine_max_acceleration_x: ['5000', '5000'] },
      resolvePreset: async () => ({})
    }
  })

  const written = JSON.parse(strFromU8(unzipSync(bytes)['Metadata/project_settings.config']!))
  assert.deepEqual(written.machine_max_acceleration_x, ['5000', '5000'], 'the user\'s value survives')
})

test('filament overrides are written, and BEFORE the retarget so the rebind preserves them', async () => {
  // Order matters for a reason the values alone do not show: the shared writer records every key it
  // writes in `different_settings_to_system`, and that record is what makes the retarget's rebind
  // preserve the user's edit instead of rebinding it away.
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/project_settings.config': projectSettings()
  }))
  const { bytes } = await bakeClientThreeMf(archive, EMPTY_EDIT, [], {}, {
    filamentSettingOverrides: {
      overrides: { 1: { nozzle_temperature: ['235'] } },
      resolveSlotConfigs: async () => [null]
    }
  })

  const written = JSON.parse(strFromU8(unzipSync(bytes)['Metadata/project_settings.config']!))
  assert.deepEqual(written.nozzle_temperature, ['235'])
  assert.ok(
    JSON.stringify(written.different_settings_to_system ?? []).includes('nozzle_temperature'),
    'the write is recorded, which is what survives a later rebind'
  )
})

test('slot presets that will not resolve still let present keys be written', async () => {
  // Best-effort: the override also rides the slice request, so a save must never fail because one
  // could not be persisted into the file.
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/project_settings.config': projectSettings({ nozzle_temperature: ['220'] })
  }))
  const { bytes } = await bakeClientThreeMf(archive, EMPTY_EDIT, [], {}, {
    filamentSettingOverrides: {
      overrides: { 1: { nozzle_temperature: ['235'] } },
      resolveSlotConfigs: async () => { throw new Error('offline') }
    }
  })

  const written = JSON.parse(strFromU8(unzipSync(bytes)['Metadata/project_settings.config']!))
  assert.deepEqual(written.nozzle_temperature, ['235'])
})

test('a non-H2 project is never touched by the topology heal', async () => {
  let asked = 0
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/project_settings.config': projectSettings()
  }))
  await bakeClientThreeMf(archive, EMPTY_EDIT, [], {}, {
    machineTopologyHeal: async () => { asked += 1; return {} }
  })

  assert.equal(asked, 0, 'a P1S has no dual-nozzle topology to be missing')
})

test('the heal is skipped when a retarget already rebuilt the topology', async () => {
  // The api's own branching: heal is the ALTERNATIVE to a retarget, never additional.
  let asked = 0
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/project_settings.config': projectSettings({ printer_settings_id: 'Bambu Lab H2D 0.4 nozzle' })
  }))
  await bakeClientThreeMf(archive, EMPTY_EDIT, [], {}, {
    machineRetarget: async () => ({
      machineConfig: { printer_model: ['Bambu Lab H2D'] },
      printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
      printerModel: 'Bambu Lab H2D',
      processConfig: null,
      processSettingOverrides: {},
      filamentRebinds: null,
      nozzleDiameters: null
    }),
    machineTopologyHeal: async () => { asked += 1; return {} }
  })

  assert.equal(asked, 0, 'the retarget just rebuilt it')
})

test('an H2 project missing its dual-nozzle data is re-authored from the machine it names', async () => {
  // The damage this exists for: without `physical_extruder_map` the CLI's extruder-variant
  // resolution crashes, and the per-slot nozzle assignment silently stops saving, because the
  // assignment write no-ops without it.
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/project_settings.config': projectSettings({
      printer_model: ['Bambu Lab H2D'],
      printer_settings_id: 'Bambu Lab H2D 0.4 nozzle'
    })
  }))
  const { bytes } = await bakeClientThreeMf(archive, EMPTY_EDIT, [], {}, {
    machineTopologyHeal: async (machineName) => {
      assert.equal(machineName, 'Bambu Lab H2D 0.4 nozzle', 'resolved by the name the project itself carries')
      return {
        printer_model: ['Bambu Lab H2D'],
        physical_extruder_map: ['0', '1'],
        extruder_nozzle_stats: ['0', '0'],
        extruder_max_nozzle_count: ['1', '1'],
        default_nozzle_volume_type: ['Standard', 'Standard']
      }
    }
  })

  const written = JSON.parse(strFromU8(unzipSync(bytes)['Metadata/project_settings.config']!))
  assert.deepEqual(written.physical_extruder_map, ['0', '1'], 'the topology is restored')
})
