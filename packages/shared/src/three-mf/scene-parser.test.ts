import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSceneManifest, parseBrimEarPoints, parseRootModelObjectIdOrder } from './scene-parser.js'

/**
 * These lock the contract the parser gained when it moved out of `apps/api` so the browser could
 * call it too (the public 3MF editor unzips locally and never uploads the file). The API's
 * `readSceneManifest` tests cover the same logic through Node ZIP I/O; these prove it works from
 * plain strings, with no filesystem, which is the only thing the browser can offer.
 */

const MODEL_SETTINGS_XML = [
  '<config>',
  '  <object id="3">',
  '    <metadata key="name" value="Box"/>',
  '    <part id="1" subtype="normal_part"><metadata key="name" value="Box part"/><metadata key="extruder" value="1"/></part>',
  '  </object>',
  '  <object id="11">',
  '    <metadata key="name" value="Lid"/>',
  '    <part id="2" subtype="support_blocker"><metadata key="name" value="Blocker"/></part>',
  '  </object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
  '    <model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="0"/></model_instance>',
  '  </plate>',
  '</config>'
].join('\n')

const ROOT_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  '  <resources>',
  '    <object id="3" type="model"><components><component objectid="1" p:path="/3D/Objects/object_1.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>',
  '    <object id="11" type="model"><components><component objectid="2" p:path="/3D/Objects/object_2.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>',
  '  </resources>',
  '  <build>',
  '    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"/>',
  '    <item objectid="11" transform="1 0 0 0 1 0 0 0 1 140 100 0" printable="0"/>',
  '  </build>',
  '</model>'
].join('\n')

const PROJECT_SETTINGS_JSON = JSON.stringify({
  printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
  filament_colour: ['#FF0000', '#00FF00'],
  filament_type: ['PLA', 'PETG']
})

test('buildSceneManifest builds a plated scene from entry strings alone', () => {
  const scene = buildSceneManifest({
    rootModelXml: ROOT_MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: PROJECT_SETTINGS_JSON
  }, 1)

  assert.equal(scene.plateIndex, 1)
  assert.equal(scene.parts.length, 2)
  assert.deepEqual(scene.instances.map((instance) => instance.objectId), [3, 11])
  assert.equal(scene.instances[0]?.name, 'Box')
  // The build item said printable="0"; the DTO carries the flag only when skipped.
  assert.equal(scene.instances[0]?.printable, undefined)
  assert.equal(scene.instances[1]?.printable, false)
})

test('buildSceneManifest resolves part filament from the project palette', () => {
  const scene = buildSceneManifest({
    rootModelXml: ROOT_MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: PROJECT_SETTINGS_JSON
  }, 1)

  const boxPart = scene.parts.find((part) => part.objectId === 1)
  assert.equal(boxPart?.filamentId, 1)
  assert.equal(boxPart?.color, '#FF0000')

  // A support blocker is a helper volume: it carries no filament and must never inherit one,
  // mirroring BambuStudio's extruder-swatch rule.
  const blockerPart = scene.parts.find((part) => part.objectId === 2)
  assert.equal(blockerPart?.subtype, 'support_blocker')
  assert.equal(blockerPart?.filamentId, null)
  assert.equal(blockerPart?.color, null)
})

test('buildSceneManifest places parts in plate-local coordinates', () => {
  const scene = buildSceneManifest({
    rootModelXml: ROOT_MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: PROJECT_SETTINGS_JSON
  }, 1)

  // The transforms above are absolute bed coordinates; the scene reports them relative to the
  // plate, so the two objects must stay 40mm apart while neither keeps its raw 100/140 x.
  const xs = scene.instances.map((instance) => instance.transform[9] ?? 0)
  assert.equal((xs[1] ?? 0) - (xs[0] ?? 0), 40)
})

test('a printer override decodes every plate with the source grid before centering it on the target bed', () => {
  const modelSettingsXml = [
    '<config>',
    ...[1, 2, 3].map((id) => `<object id="${id}"><part id="${100 + id}" subtype="normal_part"/></object>`),
    ...[1, 2, 3].map((id) => [
      '<plate>',
      `  <metadata key="plater_id" value="${id}"/>`,
      `  <model_instance><metadata key="object_id" value="${id}"/><metadata key="instance_id" value="0"/></model_instance>`,
      '</plate>'
    ].join('\n')),
    '</config>'
  ].join('\n')
  // Three 256 mm plates use a 2-column grid. Each object is at its own plate centre: plate 2 has
  // one +307.2 mm X stride, while plate 3 has one -307.2 mm Y stride.
  const rootModelXml = [
    '<model><resources>',
    ...[1, 2, 3].map((id) => `<object id="${id}"><components><component objectid="${100 + id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>`),
    '</resources><build>',
    '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/>',
    '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 435.2 128 0"/>',
    '<item objectid="3" transform="1 0 0 0 1 0 0 0 1 128 -179.2 0"/>',
    '</build></model>'
  ].join('\n')
  const entries = {
    rootModelXml,
    modelSettingsXml,
    projectSettingsJson: JSON.stringify({
      printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
      printable_area: ['0x0', '256x0', '256x256', '0x256'],
      printable_height: '256'
    })
  }

  for (const plate of [1, 2, 3]) {
    const scene = buildSceneManifest(entries, plate, 'H2D')
    assert.equal(scene.bed.minX, 0)
    assert.equal(scene.bed.maxX, 350)
    assert.ok(Math.abs((scene.instances[0]?.transform[9] ?? 0) - 175) < 1e-9, `plate ${plate} X drifted`)
    assert.ok(Math.abs((scene.instances[0]?.transform[10] ?? 0) - 160) < 1e-9, `plate ${plate} Y drifted`)
    assert.ok(Math.abs((scene.parts[0]?.transform[9] ?? 0) - 175) < 1e-9, `plate ${plate} part X drifted`)
  }
})

test('buildSceneManifest falls back to the first plate when the index is absent', () => {
  const scene = buildSceneManifest({
    rootModelXml: ROOT_MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: PROJECT_SETTINGS_JSON
  }, 7)

  assert.equal(scene.plateIndex, 1)
})

test('buildSceneManifest throws when the project carries no plated scene metadata', () => {
  assert.throws(() => buildSceneManifest({
    rootModelXml: ROOT_MODEL_XML,
    modelSettingsXml: '<config></config>'
  }, 1), /does not include any plated scene metadata/)
})

test('buildSceneManifest tolerates missing optional entries', () => {
  const scene = buildSceneManifest({
    rootModelXml: ROOT_MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML
  }, 1)

  // No project settings: a generic bed, no palette, but the geometry still places.
  assert.equal(scene.parts.length, 2)
  assert.ok(scene.bed.maxX > scene.bed.minX)
  assert.equal(scene.projectFilaments, undefined)
})

test('a project that names no prime-tower position defaults to a reachable spot, not the bed edge', () => {
  // Regression: the old 15/220 fallback sat inside an H2D's left-nozzle-only strip (its shared
  // area starts at x=25), so a project that never positioned its tower opened unprintable and a
  // save baked the bad value in. BambuStudio uses mid-bed 165/250 (PartPlate.cpp).
  const scene = buildSceneManifest({
    rootModelXml: ROOT_MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: JSON.stringify({
      enable_prime_tower: '1',
      prime_tower_width: '60',
      printable_area: ['0x0', '350x0', '350x320', '0x320'],
      extruder_printable_area: ['0x0,325x0,325x320,0x320', '25x0,350x0,350x320,25x320']
    })
  }, 1)
  const tower = scene.primeTower
  assert.ok(tower, 'expected a prime tower')
  assert.equal(tower?.x, 165)
  assert.equal(tower?.y, 250)
  // The whole tower must clear the left-nozzle-only strip (x < 25).
  assert.ok((tower?.x ?? 0) >= 25, 'default tower must start inside the shared reachable area')
})

test('vase mode is parsed onto the tower sizing, so the tower gate can match BambuStudio', () => {
  // `Print::has_wipe_tower`: with the tower enabled it returns early for the forcing conditions,
  // and only then falls through to `!spiral_mode && filament_diameter.size() > 1`. So vase mode
  // suppresses the tower against the FILAMENT COUNT but never against timelapse/wrapping, a
  // distinction the gate cannot make without this flag.
  const sizingFor = (extra: Record<string, unknown>) => buildSceneManifest({
    rootModelXml: ROOT_MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: JSON.stringify({ enable_prime_tower: '1', prime_tower_width: '60', ...extra })
  }, 1).primeTower?.sizing

  assert.equal(sizingFor({ spiral_mode: '1' })?.spiralMode, true)
  assert.equal(sizingFor({ spiral_mode: '0' })?.spiralMode, false)
  // Absent is the overwhelmingly common case and must read as "not vase mode", never undefined.
  assert.equal(sizingFor({})?.spiralMode, false)
  // Vase mode does not clear a FORCED tower; the two are independent inputs to the gate.
  const forced = sizingFor({ spiral_mode: '1', timelapse_type: 'smooth' })
  assert.equal(forced?.spiralMode, true)
  assert.equal(forced?.needWipeTower, true)
})

/**
 * The object ordinal space every positional sidecar uses (`brim_ear_points.txt`,
 * `layer_config_ranges.xml`, `layer_heights_profile.txt`, `cut_information.xml`).
 *
 * The fixture deliberately writes its `<object>` resources in ASCENDING ID order while its build
 * items name them in a different order, because that is the shape of every real project that has
 * been edited: BambuStudio's exporter correlates the two, so a file it just wrote cannot tell the
 * readings apart, and a fixture that keeps them aligned passes against the bug.
 */
const DIVERGENT_ORDER_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter">',
  '  <resources>',
  '    <object id="4" type="model"><mesh/></object>',
  '    <object id="7" type="model"><mesh/></object>',
  '    <object id="9" type="model"><mesh/></object>',
  // Not build-placed: a multi-solid import's component mesh. It must consume no ordinal.
  '    <object id="12" type="model"><mesh/></object>',
  '  </resources>',
  '  <build>',
  '    <item objectid="9" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>',
  '    <item objectid="4" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>',
  // A second instance of an object already placed: it adds a ModelInstance, not a ModelObject,
  // so it must not take an ordinal of its own.
  '    <item objectid="9" transform="1 0 0 0 1 0 0 0 1 40 0 0" printable="1"/>',
  '    <item objectid="7" transform="1 0 0 0 1 0 0 0 1 80 0 0" printable="1"/>',
  '  </build>',
  '</model>'
].join('\n')

test('the object ordinal space is build-item order, not <object> resource order', () => {
  // Measured against the real thing: a 137-object customer project whose two orders diverge was
  // round-tripped through the BambuStudio 2.7.1 CLI, and all 137 objects came back in the input's
  // BUILD-ITEM order. Its brim ear at ordinal 17 resolved to "Cam 1" (build order), not to
  // "Side gear peg" (resource order), and was re-exported still attached to "Cam 1".
  assert.deepEqual(parseRootModelObjectIdOrder(DIVERGENT_ORDER_MODEL_XML), [9, 4, 7])
})

test('an unplaced object takes no ordinal, and a second instance does not take another', () => {
  const order = parseRootModelObjectIdOrder(DIVERGENT_ORDER_MODEL_XML)
  // `<object id="12">` has no build item: BambuStudio never creates a ModelObject for it.
  assert.equal(order.includes(12), false, 'an object with no build item is not in the list')
  // Object 9 is placed twice; the importer's second visit takes the `else` branch and only calls
  // `add_instance`, so it must appear once.
  assert.deepEqual(order.filter((id) => id === 9), [9], 'a linked copy does not shift later ordinals')
})

test('a build item naming an object with no resource is skipped rather than shifting the rest', () => {
  const xml = DIVERGENT_ORDER_MODEL_XML.replace(
    '<item objectid="4"',
    '<item objectid="99" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n    <item objectid="4"'
  )
  // The importer fails that lookup (`m_current_objects.find`) and refuses the file outright, so it
  // never allocates an index for it. Counting it would move every later object up one.
  assert.deepEqual(parseRootModelObjectIdOrder(xml), [9, 4, 7])
})

test('brim ears resolve through the build-item ordinal', () => {
  const ears = parseBrimEarPoints('brim_points_format_version=1\nobject_id=2|1 2 3 4', DIVERGENT_ORDER_MODEL_XML)
  // Ordinal 2 is object 4 in build order; it is object 7 in resource order.
  assert.deepEqual([...ears.keys()], [4])
  assert.deepEqual(ears.get(4), [{ x: 1, y: 2, z: 3, radius: 4 }])
})
