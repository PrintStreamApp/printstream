/**
 * Per-plate settings authoring: bed type, print sequence, vase mode and the arrange lock.
 *
 * These are engine-authoritative overrides, not decoration. The CLI applies a plate's config OVER
 * the loaded project config (`BambuStudio.cpp:6897`), so a plate that names `bed_type` prints on a
 * different surface (and at a different first-layer temperature) than the project says, and a plate
 * that names `spiral_mode` slices as a vase whatever the process preset holds.
 *
 * The invariant every case here defends is that one plate block carries at most ONE value for a key.
 * The block is re-rendered from the edit and the source's own entries are carried alongside, so an
 * authored key that is not also suppressed from the carry is emitted twice, and BambuStudio's parser
 * keeps the LAST one it sees (`bbs_3mf.cpp:4615-4656` assigns per key as it walks).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'
import type { SceneEdit, SceneEditPlate } from '../slicing.js'

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter">',
  ' <resources>',
  '  <object id="1" type="model"><mesh><vertices/><triangles/></mesh></object>',
  ' </resources>',
  ' <build><item objectid="1"/></build>',
  '</model>'
].join('\n')

/**
 * A source plate carrying every per-plate setting.
 *
 * `spiral_mode="1"` is deliberately NOT the spelling Studio writes (it emits `true`, boolalpha being
 * sticky from the `locked` line): it stands for a hand-edited or script-written file, and the carry
 * path must pass an unrecognised spelling through untouched rather than normalising it.
 */
const MODEL_SETTINGS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="1"><metadata key="name" value="A"/></object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <metadata key="bed_type" value="Cool Plate"/>',
  '    <metadata key="print_sequence" value="by object"/>',
  '    <metadata key="spiral_mode" value="1"/>',
  '    <metadata key="locked" value="true"/>',
  '  </plate>',
  '</config>'
].join('\n')

function source(): ThreeMfBakeSource {
  return {
    modelXml: MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: null,
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: new Map(),
    hasBase: true
  }
}

/** An edit from a client new enough to distinguish a plate's own bed type from the global. */
function edit(plate: Partial<SceneEditPlate>, plateType: string | null = 'Textured PEI Plate'): SceneEdit {
  return {
    plates: [{ index: 1, sourceIndex: 1, ...plate }],
    ...(plateType == null ? {} : { plateType }),
    instances: [{
      objectId: 1,
      plateIndex: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }
    }]
  } as unknown as SceneEdit
}

function bake(sceneEdit: SceneEdit): string {
  const plan = planEditedThreeMf(source(), sceneEdit)
  return plan.copy?.transforms.get('Metadata/model_settings.config')?.('') ?? ''
}

/** Every `<metadata key="X" .../>` value for one key, so a duplicate is visible rather than masked. */
function valuesOf(xml: string, key: string): string[] {
  return [...xml.matchAll(new RegExp(`key="${key}" value="([^"]*)"`, 'g'))].map((match) => match[1] ?? '')
}

test('a plate authors its own bed type, and the authored value is the only one in the block', () => {
  const out = bake(edit({ plateType: 'Engineering Plate' }))
  assert.deepEqual(valuesOf(out, 'bed_type'), ['Engineering Plate'])
})

test('"same as global" removes the plate\'s bed type rather than leaving the source\'s behind', () => {
  // The tri-state that is easiest to collapse: null is an explicit choice to inherit, and must
  // suppress the carry. Treating it as "the edit said nothing" puts Cool Plate straight back.
  const out = bake(edit({ plateType: null }))
  assert.deepEqual(valuesOf(out, 'bed_type'), [])
})

test('a plate that says nothing about a key keeps the source value', () => {
  // Not the same as null: an edit built by an older client mentions none of these, and dropping
  // them would silently discard settings the user made in BambuStudio.
  const out = bake(edit({}))
  assert.deepEqual(valuesOf(out, 'print_sequence'), ['by object'])
  assert.deepEqual(valuesOf(out, 'spiral_mode'), ['1'])
  assert.deepEqual(valuesOf(out, 'locked'), ['true'])
})

test('vase mode is written in the spelling the engine reads', () => {
  // `true`/`false`, which is what BambuStudio writes too: its `spiral_mode` line streams a bare
  // getBool() (`bbs_3mf.cpp:8376`), but `std::boolalpha` was set on that same stream by the `locked`
  // line above (`:8334`) and is sticky, so it emits `true` and its boolalpha reader (`:4652`) takes
  // it back. Writing `1` here would NOT round-trip, since that reader accepts neither `1` nor `0`.
  assert.deepEqual(valuesOf(bake(edit({ spiralMode: true })), 'spiral_mode'), ['true'])
  assert.deepEqual(valuesOf(bake(edit({ spiralMode: false })), 'spiral_mode'), ['false'])
})

test('print sequence and the arrange lock author over the source', () => {
  const out = bake(edit({ printSequence: 'by layer', locked: false }))
  assert.deepEqual(valuesOf(out, 'print_sequence'), ['by layer'])
  // Unlocking writes nothing at all rather than `locked="false"`: absence IS unlocked, and the
  // carried `locked="true"` must not survive the user clearing it.
  assert.deepEqual(valuesOf(out, 'locked'), [])
})

test('an edit that names no global plate type cannot author a per-plate bed type', () => {
  // Back-compat, and the reason the global is the discriminator. A client from before per-plate bed
  // types stamped the GLOBAL onto every plate, so reading those values as overrides would convert
  // one project-wide setting into N per-plate ones that outlive the user's next change to it.
  const out = bake(edit({ plateType: 'Engineering Plate' }, null))
  assert.deepEqual(valuesOf(out, 'bed_type'), [])
})

test('a client that states a NULL global still authors per-plate bed types', () => {
  // The discriminator is the key's PRESENCE, not its truthiness. A current client sends
  // `plateType: null` when the project states no global (an unseeded machine target), and reading
  // that as "an old client" would both refuse to author the plate's own bed type AND, since the
  // carry no longer covers `bed_type`, silently delete the one already in the file.
  const withNullGlobal = { ...edit({ plateType: 'Engineering Plate' }), plateType: null } as unknown as SceneEdit
  assert.deepEqual(valuesOf(bake(withNullGlobal), 'bed_type'), ['Engineering Plate'])
})

/** The project's own `curr_bed_type` after a bake, or null when the bake left it alone. */
function bakedGlobalBedType(sceneEdit: SceneEdit, projectSettingsJson: string): string | null {
  const plan = planEditedThreeMf({ ...source(), projectSettingsJson }, sceneEdit)
  const transform = plan.copy?.transforms.get('Metadata/project_settings.config')
  const out = transform?.(projectSettingsJson) ?? projectSettingsJson
  return (JSON.parse(out) as { curr_bed_type?: string }).curr_bed_type ?? null
}

test('an edit with a null global does not promote a plate override to the project-wide value', () => {
  // The pre-per-plate FALLBACK reads the first plate that names a type and writes it as
  // `curr_bed_type`. It must run only for a client that sends no global AT ALL: a current client
  // with nothing to state sends null, and promoting a plate's override there makes one plate's
  // choice the project's, which every inheriting plate then prints on.
  const project = JSON.stringify({ curr_bed_type: 'Cool Plate' })
  const withNullGlobal = { ...edit({ plateType: 'Engineering Plate' }), plateType: null } as unknown as SceneEdit
  assert.equal(bakedGlobalBedType(withNullGlobal, project), 'Cool Plate', 'the project keeps its own value')

  // An edit that DOES state a global writes that global, never the plate's.
  const withGlobal = edit({ plateType: 'Engineering Plate' }, 'Textured PEI Plate')
  assert.equal(bakedGlobalBedType(withGlobal, project), 'Textured PEI Plate')

  // And a genuinely old client (no key at all) still has its stamped plates read as the global.
  const legacy = edit({ plateType: 'Engineering Plate' }, null)
  assert.equal(bakedGlobalBedType(legacy, project), 'Engineering Plate')
})

test('a plate settings edit still renders exactly one plater_id', () => {
  // The carry and the author both write into one block; this is the cheapest check that they have
  // not started duplicating each other.
  const out = bake(edit({ plateType: 'Engineering Plate', printSequence: 'by object', spiralMode: true, locked: true }))
  assert.equal(valuesOf(out, 'plater_id').length, 1)
})
