import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_EDITOR_MATERIALS,
  editorMaterialsFromProjectFilaments,
  editorMaterialsFromSliceConfig
} from './editorMaterials'

/**
 * The precedence rules here are behaviour the editor's swatches and pickers depended on while this
 * logic was inline in `EditorView`. They are asserted rather than described because getting either
 * one backwards is invisible until a user edits a material and the editor keeps showing the old one.
 */

test('the slice-config source prefers the live selection over the project label and colour', () => {
  const materials = editorMaterialsFromSliceConfig({
    projectFilaments: [
      { projectFilamentId: 1, label: 'Bambu PLA Basic', color: '#ffffff' },
      { projectFilamentId: 2, label: 'Generic PETG', color: '#00ff00' }
    ],
    // Slot 1 was re-picked and recoloured this session; slot 2 was left alone.
    filamentColors: { 1: '#ff0000' },
    filamentMaterialOptionIds: { 1: 'opt-abs' },
    materialOptions: [{ id: 'opt-abs', label: 'Bambu ABS', materialType: 'ABS' }]
  })

  assert.equal(materials.options[0]?.label, 'ABS', 'the selected material type wins over the baked label')
  assert.equal(materials.options[0]?.color, '#ff0000', 'the session colour wins over the baked colour')
  assert.equal(materials.options[1]?.label, 'Generic PETG', 'an untouched slot keeps the project label')
  assert.equal(materials.options[1]?.color, '#00ff00')
  // Slot ids are BambuStudio's 1-based project filament ids and must pass through untouched --
  // colour-paint codes and `extruder` metadata reference these exact numbers.
  assert.deepEqual(materials.options.map((option) => option.id), [1, 2])
})

test('the slice-config source falls back to the option label when it carries no material type', () => {
  const materials = editorMaterialsFromSliceConfig({
    projectFilaments: [{ projectFilamentId: 1, label: 'baked', color: null }],
    filamentMaterialOptionIds: { 1: 'opt-x' },
    materialOptions: [{ id: 'opt-x', label: 'Some Custom Filament' }]
  })
  assert.equal(materials.options[0]?.label, 'Some Custom Filament')
})

test('no project filaments yields the empty materials, so hosts can treat it as "not resolved yet"', () => {
  assert.equal(editorMaterialsFromSliceConfig(undefined), EMPTY_EDITOR_MATERIALS)
  assert.equal(editorMaterialsFromSliceConfig({ projectFilaments: [] }), EMPTY_EDITOR_MATERIALS)
})

test('the project-filament source reads a parsed 3MF with no slice controller present', () => {
  // Exactly the shape the shared index parser produces, which is what a host with only a local
  // file has to work from.
  const materials = editorMaterialsFromProjectFilaments([
    { id: 1, filamentName: 'Bambu PLA Basic', filamentType: 'PLA', color: '#ffffff' },
    { id: 2, filamentName: null, filamentType: null, color: null }
  ])

  assert.equal(materials.options[0]?.label, 'PLA')
  assert.equal(materials.options[0]?.color, '#ffffff')
  assert.deepEqual(materials.colorById, { 1: '#ffffff' }, 'only slots with a colour appear in the map')
  // A slot the project describes with nothing at all still occupies its id, or every later slot
  // would shift and repaint the model.
  assert.equal(materials.options[1]?.id, 2)
  assert.equal(materials.options[1]?.label, null)
})
