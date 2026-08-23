/**
 * A per-object filament REFERENCE must not survive the slot it points at.
 *
 * BambuStudio guards this at slice time: `PrintObject.cpp` clamps `support_filament`,
 * `support_interface_filament`, `wall_filament`, `sparse_infill_filament` and
 * `solid_infill_filament` to 1 whenever they exceed the filament count, and clamps the object's own
 * extruder the same way. That keeps the PRINT sane while leaving the file dangling.
 *
 * We do it at authoring time instead, which is the stronger position: the saved project is
 * self-consistent rather than relying on the engine to paper over it, and a reader that does not
 * clamp (BambuStudio's own project loader, our parsers) sees a coherent document. This pins that
 * behaviour, which nothing covered.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildEditedThreeMfDocuments, NEW_PROJECT_MODEL_XML } from './bake-documents'
import type { SceneEdit } from '../slicing'

/**
 * A root model that DECLARES the object being placed. The bake refuses a build item naming an object
 * the model does not contain (it would strip the real geometry and produce a file BambuStudio
 * refuses to open), so a fixture cannot place an object into an empty `<resources>`.
 */
function modelXmlDeclaring(objectId: number): string {
  return NEW_PROJECT_MODEL_XML.replace(
    '  </resources>',
    `    <object id="${objectId}" type="model"><mesh><vertices/><triangles/></mesh></object>\n  </resources>`
  )
}


const at = { x: 0, y: 0, z: 0 }
const unit = { x: 1, y: 1, z: 1 }

/** An object bound to material 3, with per-object overrides pointing at 3 and at 2. */
const MODEL_SETTINGS = [
  '<config>',
  '  <object id="5">',
  '    <metadata key="name" value="Bracket"/>',
  '    <metadata key="extruder" value="3"/>',
  '    <metadata key="support_filament" value="3"/>',
  '    <metadata key="wall_filament" value="2"/>',
  '    <part id="5" subtype="normal_part">',
  '      <metadata key="extruder" value="3"/>',
  '    </part>',
  '  </object>',
  '</config>'
].join('\n')

function bakeWithFilaments(filaments: SceneEdit['filaments']): string {
  const edit = {
    plates: [{ index: 1 }],
    instances: [{ objectId: 5, instanceId: 1, plateIndex: 1, position: at, rotation: at, scale: unit }],
    filaments
  } as SceneEdit
  const { modelSettingsXml } = buildEditedThreeMfDocuments(modelXmlDeclaring(5), MODEL_SETTINGS, null, edit, [])
  return modelSettingsXml.match(/<object id="5">[\s\S]*?<\/object>/)?.[0] ?? ''
}

test('removing a material rewrites every reference to it, at both levels', () => {
  const block = bakeWithFilaments([
    { color: '#1', type: 'PLA', settingsId: 'A', sourceIndex: 0 },
    { color: '#2', type: 'PETG', settingsId: 'B', sourceIndex: 1 }
  ] as SceneEdit['filaments'])

  // The object's material falls back to 1, which is what BambuStudio would have clamped it to.
  assert.match(block, /<metadata key="extruder" value="1"\/>/)
  assert.doesNotMatch(block, /value="3"/, 'nothing may still point at the removed slot')
  // The part-level entry is clamped too: a reader binds the volume before the object.
  assert.equal((block.match(/<metadata key="extruder" value="1"\/>/g) ?? []).length, 2)
  // A per-object override cannot be clamped truthfully (1 is a different material, not a default),
  // so it is dropped and the slot falls back to the project-wide value.
  assert.doesNotMatch(block, /support_filament/)
  // An override pointing at a SURVIVING slot is untouched: only the dangling ones move.
  assert.match(block, /<metadata key="wall_filament" value="2"\/>/)
})

test('reordering materials moves the references with them rather than clamping', () => {
  // Slot 2 becomes slot 1 and slot 1 becomes slot 2. Nothing is removed, so nothing falls back:
  // clamping here would silently repaint an object that merely moved position.
  const block = bakeWithFilaments([
    { color: '#2', type: 'PETG', settingsId: 'B', sourceIndex: 1 },
    { color: '#1', type: 'PLA', settingsId: 'A', sourceIndex: 0 },
    { color: '#3', type: 'ABS', settingsId: 'C', sourceIndex: 2 }
  ] as SceneEdit['filaments'])

  assert.match(block, /<metadata key="extruder" value="3"\/>/, 'slot 3 survived, so the binding stays')
  assert.match(block, /<metadata key="support_filament" value="3"\/>/)
  assert.match(block, /<metadata key="wall_filament" value="1"\/>/, 'the old slot 2 is now slot 1')
})
