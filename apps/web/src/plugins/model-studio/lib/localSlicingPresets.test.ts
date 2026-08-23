import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { installJsdomGlobals } from '../../../test-utils/jsdom'
import {
  LocalSlicingPresetError,
  addLocalSlicingPresets,
  clearLocalSlicingPresets,
  listLocalSlicingPresets,
  removeLocalSlicingPreset
} from './localSlicingPresets'

/**
 * These presets never reach a server, so the browser is the only thing validating them. The parse
 * is the SHARED one on purpose, a file the workspace would accept must not be rejected here, and
 * vice versa, so what is worth asserting locally is the storage behaviour around it.
 */

const filamentPreset = JSON.stringify({
  type: 'filament',
  name: 'My PETG',
  filament_settings_id: ['My PETG'],
  filament_type: ['PETG']
})

const processPreset = JSON.stringify({
  type: 'process',
  name: 'My 0.20 Draft',
  print_settings_id: ['My 0.20 Draft'],
  layer_height: '0.2'
})

function jsonFile(name: string, content: string): File {
  return new File([content], name, { type: 'application/json' })
}

function bundleFile(name: string, entries: Record<string, string>): File {
  const zipped = zipSync(Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)])))
  return new File([new Uint8Array(zipped)], name)
}

test('a .json preset is parsed and kept in the browser', async () => {
  const { window } = installJsdomGlobals()
  try {
    clearLocalSlicingPresets()
    const added = await addLocalSlicingPresets(jsonFile('My PETG.json', filamentPreset))
    assert.equal(added.length, 1)
    assert.equal(added[0]?.kind, 'filament')
    assert.equal(added[0]?.name, 'My PETG')

    // It survives as stored state, which is the whole point, there is no server to re-ask.
    const listed = listLocalSlicingPresets()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.raw.filament_type?.toString(), 'PETG')
  } finally {
    window.close()
  }
})

test('a .bbscfg/.zip bundle yields every preset inside it', async () => {
  const { window } = installJsdomGlobals()
  try {
    clearLocalSlicingPresets()
    const added = await addLocalSlicingPresets(bundleFile('Presets.bbscfg', {
      'My PETG.json': filamentPreset,
      'My 0.20 Draft.json': processPreset,
      // A real export carries files alongside the presets; they must not be errors.
      'README.txt': 'not a preset'
    }))

    assert.deepEqual(added.map((profile) => profile.kind).sort(), ['filament', 'process'])
    assert.equal(listLocalSlicingPresets().length, 2)
  } finally {
    window.close()
  }
})

test('re-uploading an edited preset replaces it rather than duplicating it', async () => {
  const { window } = installJsdomGlobals()
  try {
    clearLocalSlicingPresets()
    await addLocalSlicingPresets(jsonFile('My PETG.json', filamentPreset))
    await addLocalSlicingPresets(jsonFile('My PETG.json', JSON.stringify({
      type: 'filament', name: 'My PETG', filament_settings_id: ['My PETG'], filament_type: ['PETG-CF']
    })))

    const listed = listLocalSlicingPresets()
    // Keeping both would leave the user choosing between two identical-looking entries.
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.raw.filament_type?.toString(), 'PETG-CF')
  } finally {
    window.close()
  }
})

test('a file that is not a BambuStudio preset is refused with a reason', async () => {
  const { window } = installJsdomGlobals()
  try {
    clearLocalSlicingPresets()
    await assert.rejects(
      () => addLocalSlicingPresets(jsonFile('notes.json', '{"hello":"world"}')),
      LocalSlicingPresetError
    )
    // A refused upload must not half-store anything.
    assert.equal(listLocalSlicingPresets().length, 0)
  } finally {
    window.close()
  }
})

test('removing one preset leaves the others alone', async () => {
  const { window } = installJsdomGlobals()
  try {
    clearLocalSlicingPresets()
    await addLocalSlicingPresets(jsonFile('My PETG.json', filamentPreset))
    await addLocalSlicingPresets(jsonFile('Draft.json', processPreset))

    const [first] = listLocalSlicingPresets()
    removeLocalSlicingPreset(first!.id)
    const remaining = listLocalSlicingPresets()
    assert.equal(remaining.length, 1)
    assert.notEqual(remaining[0]?.id, first!.id)
  } finally {
    window.close()
  }
})

test('a corrupt store reads as empty rather than breaking the settings page', async () => {
  const { window } = installJsdomGlobals()
  try {
    window.localStorage.setItem('printstream.modelStudio.localSlicingProfiles', 'not json')
    assert.deepEqual(listLocalSlicingPresets(), [])
  } finally {
    window.close()
  }
})
