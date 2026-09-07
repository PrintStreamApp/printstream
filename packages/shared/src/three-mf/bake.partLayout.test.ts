/**
 * The final volume layout: part ORDER and part REMOVALS resolved together.
 *
 * They share a pass because neither can run after the other. Both address BASE ordinals, so
 * reordering first moves the ordinals a removal names, and removing first moves the ordinals an
 * order names -- and the failure is silent either way, landing the edit on a neighbouring volume.
 * Every other part-scoped applier runs before this one for the same reason.
 *
 * Order is portable as-is: the `<component>` sequence IS the volume list BambuStudio reads
 * (`_handle_start_config_volume` keys a volume by its position, not by the `id` attribute), and it
 * carries slicing meaning because the engine requires the first volume to be a normal part.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPartLayout, resolvePartLayout } from './bake-documents.js'

const MODEL_XML = [
  '<model unit="millimeter">',
  ' <resources>',
  '  <object id="5" type="model"><components>',
  '   <component objectid="20" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
  '   <component objectid="21" transform="1 0 0 0 1 0 0 0 1 1 0 0"/>',
  '   <component objectid="22" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>',
  '  </components></object>',
  '  <object id="6" type="model"><components>',
  '   <component objectid="30" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
  '   <component objectid="31" transform="1 0 0 0 1 0 0 0 1 1 0 0"/>',
  '  </components></object>',
  ' </resources>',
  ' <build><item objectid="5"/><item objectid="6"/></build>',
  '</model>'
].join('\n')

const SETTINGS_XML = [
  '<config>',
  ' <object id="5">',
  '  <part id="20" subtype="normal_part"><metadata key="name" value="A0"/></part>',
  '  <part id="21" subtype="modifier_part"><metadata key="name" value="A1"/></part>',
  '  <part id="22" subtype="normal_part"><metadata key="name" value="A2"/></part>',
  ' </object>',
  ' <object id="6">',
  '  <part id="30" subtype="normal_part"><metadata key="name" value="B0"/></part>',
  '  <part id="31" subtype="normal_part"><metadata key="name" value="B1"/></part>',
  ' </object>',
  '</config>'
].join('\n')

/** The `<component objectid>`s of one object, in document order. */
const components = (modelXml: string, objectId: number): number[] => {
  const block = new RegExp(`<object\\b[^>]*\\bid="${objectId}"[\\s\\S]*?</object>`).exec(modelXml)?.[0] ?? ''
  return [...block.matchAll(/<component\b[^>]*objectid="(\d+)"/g)].map((match) => Number(match[1]))
}

/** The `<part>` names of one object, in document order. */
const partNames = (settingsXml: string, objectId: number): string[] => {
  const block = new RegExp(`<object\\b[^>]*\\bid="${objectId}"[\\s\\S]*?</object>`).exec(settingsXml)?.[0] ?? ''
  return [...block.matchAll(/<part\b[\s\S]*?value="([^"]*)"/g)].map((match) => match[1] ?? '')
}

test('resolvePartLayout applies the order and then drops the removals', () => {
  assert.deepEqual(resolvePartLayout(3, [2, 0, 1], new Set()), [2, 0, 1])
  assert.deepEqual(resolvePartLayout(3, [2, 0, 1], new Set([0])), [2, 1])
  // Removals alone, which is the behaviour every existing project relies on.
  assert.deepEqual(resolvePartLayout(4, undefined, new Set([1, 2])), [0, 3])
})

test('a partial order is the NORMAL shape once a removal is pending, not just a stale edit', () => {
  // The client records the order of the parts it still has, so a pending removal is simply absent
  // from it. `[2, 0]` over three volumes with 1 removed is what a real "delete part 1, then drag
  // part 2 to the front" session emits -- not a defensive case.
  assert.deepEqual(resolvePartLayout(3, [2, 0], new Set([1])), [2, 0])
})

test('a partial order shuffles only the slots it names', () => {
  // Ordinals 0 and 2 occupy slots 0 and 2; they swap through those, and 1 does not move. This is
  // what makes a STALE order (composed before a part was deleted) a no-op for what it omits rather
  // than a reshuffle of the whole object.
  assert.deepEqual(resolvePartLayout(3, [2, 0], new Set()), [2, 1, 0])
})

test('resolvePartLayout ignores ordinals the object does not have, and duplicates', () => {
  // A duplicate would place one volume twice and silently drop another.
  assert.deepEqual(resolvePartLayout(3, [2, 2, 0, 1], new Set()), [2, 0, 1])
  assert.deepEqual(resolvePartLayout(3, [9, 2, 0, 1], new Set()), [2, 0, 1])
  // Nothing left to move: the object keeps the base order rather than collapsing.
  assert.deepEqual(resolvePartLayout(3, [9], new Set()), [0, 1, 2])
})

test('a reorder rewrites the components and the model_settings parts together', () => {
  // BambuStudio pairs the two documents by POSITION first and only falls back to a linear id
  // search, so moving one without the other loads but takes the slow path and reads as a part
  // whose name and subtype belong to its neighbour.
  const applied = applyPartLayout(MODEL_XML, SETTINGS_XML, [], [{ objectId: 5, order: [2, 0, 1] }])
  assert.deepEqual(components(applied.modelXml, 5), [22, 20, 21])
  assert.deepEqual(partNames(applied.modelSettingsXml, 5), ['A2', 'A0', 'A1'])
  // Each part keeps its own subtype: the blocks move whole, they are not rewritten in place.
  assert.match(applied.modelSettingsXml, /<part id="21" subtype="modifier_part">/)
  // An object with no order is untouched.
  assert.deepEqual(components(applied.modelXml, 6), [30, 31])
  assert.deepEqual(partNames(applied.modelSettingsXml, 6), ['B0', 'B1'])
})

test('a reorder and a removal in one edit both land on the volumes they named', () => {
  // The case that cannot be expressed as two passes: ordinal 1 is removed AND the survivors are
  // reordered. Running the removal first would make "order [2, 0, 1]" address a three-part object
  // that no longer exists; running the reorder first would make "remove 1" delete whichever part
  // slid into slot 1, which is part 0.
  const applied = applyPartLayout(
    MODEL_XML,
    SETTINGS_XML,
    [{ objectId: 5, partIndex: 1 }],
    [{ objectId: 5, order: [2, 0, 1] }]
  )
  assert.deepEqual(components(applied.modelXml, 5), [22, 20])
  assert.deepEqual(partNames(applied.modelSettingsXml, 5), ['A2', 'A0'])
})

test('an unchanged layout returns the documents byte for byte', () => {
  // An ordinary save must churn nothing: the ordinal-sidecar remap keys off the object order, and
  // a rewritten-but-identical document is also a diff nobody asked for.
  const applied = applyPartLayout(MODEL_XML, SETTINGS_XML, [], [{ objectId: 5, order: [0, 1, 2] }])
  assert.equal(applied.modelXml, MODEL_XML)
  assert.equal(applied.modelSettingsXml, SETTINGS_XML)
  // And no edit at all is a no-op without inspecting anything.
  const untouched = applyPartLayout(MODEL_XML, SETTINGS_XML, [], [])
  assert.equal(untouched.modelXml, MODEL_XML)
  assert.equal(untouched.modelSettingsXml, SETTINGS_XML)
})

test('an order naming an object that is not in the file changes nothing', () => {
  const applied = applyPartLayout(MODEL_XML, SETTINGS_XML, [], [{ objectId: 404, order: [1, 0] }])
  assert.equal(applied.modelXml, MODEL_XML)
  assert.equal(applied.modelSettingsXml, SETTINGS_XML)
})

test('the MODEL components lead, and a settings list of another length is left alone', () => {
  // BambuStudio loops over an object's COMPONENTS and looks each one's metadata up in the `<part>`
  // list positionally, guarded by an id check, falling back to an id search and then to defaults
  // (`_generate_volumes_new`). So a `<part>` list of a different length is not a positional mirror:
  // one that matches no component is never read, while a permuted one puts a name, subtype and
  // extruder on the wrong volume. Leaving it is the safe half of that trade.
  const shortSettings = SETTINGS_XML.replace(
    '  <part id="22" subtype="normal_part"><metadata key="name" value="A2"/></part>\n', ''
  )
  const applied = applyPartLayout(MODEL_XML, shortSettings, [], [{ objectId: 5, order: [2, 0, 1] }])
  assert.deepEqual(components(applied.modelXml, 5), [22, 20, 21], 'the components still reorder')
  assert.deepEqual(partNames(applied.modelSettingsXml, 5), ['A0', 'A1'], 'the mismatched parts are untouched')
  // The volume permutation reported for the sidecars is the components', which is the volume list.
  assert.deepEqual([...applied.volumeLayouts], [[5, [2, 0, 1]]])
})

test('an inline-mesh object survives an order it cannot express', () => {
  // Its mesh is inline, so it has no `<component>`s and exactly one self-referencing `<part>`.
  // There is nothing to reorder and nothing that may be dropped.
  const inlineModel = '<model><resources><object id="9" type="model"><mesh><vertices/></mesh></object></resources><build><item objectid="9"/></build></model>'
  const inlineSettings = '<config><object id="9"><part id="9" subtype="normal_part"><metadata key="name" value="Solo"/></part></object></config>'
  const applied = applyPartLayout(inlineModel, inlineSettings, [], [{ objectId: 9, order: [1, 0] }])
  assert.equal(applied.modelXml, inlineModel)
  assert.deepEqual(partNames(applied.modelSettingsXml, 9), ['Solo'])
})

/**
 * `model_settings.config` names a volume ORDINAL in a second place, and it is not inside an
 * `<object>` block, so the per-object pass above never reaches it.
 *
 * `<assemble_item object_id="N" volume_id="V">` records the assembly-view transform for one volume,
 * and BambuStudio replays it as `mo->volumes[entry.volume_id]->set_assemble_from_transform(...)`.
 * A reorder that leaves it stale therefore lands the transform on a DIFFERENT volume, and a removal
 * leaves it out of range where it is silently dropped.
 */
const ASSEMBLE_SETTINGS_XML = [
  '<config>',
  ' <object id="5">',
  '  <part id="20" subtype="normal_part"><metadata key="name" value="A0"/></part>',
  '  <part id="21" subtype="modifier_part"><metadata key="name" value="A1"/></part>',
  '  <part id="22" subtype="normal_part"><metadata key="name" value="A2"/></part>',
  ' </object>',
  ' <assemble>',
  '  <assemble_item object_id="5" volume_id="2" transform="1 0 0 0 1 0 0 0 1 9 0 0" offset="0 0 0"/>',
  ' </assemble>',
  '</config>'
].join('\n')

const assembleVolumes = (settingsXml: string): number[] =>
  [...settingsXml.matchAll(/<assemble_item\b[^>]*\bvolume_id="(\d+)"/g)].map((match) => Number(match[1]))

test('an assemble_item follows its volume through a reorder', () => {
  // Layout [2, 0, 1]: old volume 2 is now first, so the assembly transform recorded against it
  // must move to 0. Left stale it would describe volume 2, which is now old volume 1.
  const applied = applyPartLayout(MODEL_XML, ASSEMBLE_SETTINGS_XML, [], [{ objectId: 5, order: [2, 0, 1] }])
  assert.deepEqual(assembleVolumes(applied.modelSettingsXml), [0])
})

test('an assemble_item whose volume was removed is dropped, not left out of range', () => {
  // Volume 2 is gone. Renumbering onto a survivor would hand the transform to unrelated geometry,
  // and leaving it names a volume the object no longer has.
  const applied = applyPartLayout(MODEL_XML, ASSEMBLE_SETTINGS_XML, [{ objectId: 5, partIndex: 2 }], [])
  assert.deepEqual(assembleVolumes(applied.modelSettingsXml), [])
})

test('an assemble_item for an untouched object is left byte for byte alone', () => {
  const applied = applyPartLayout(MODEL_XML, ASSEMBLE_SETTINGS_XML, [], [{ objectId: 6, order: [1, 0] }])
  assert.match(applied.modelSettingsXml, /<assemble_item object_id="5" volume_id="2"/)
})

/**
 * `extruder` is a part's MATERIAL, and it is the one piece of part metadata whose landing on the
 * wrong volume is silently unprintable rather than merely odd: the parts still slice, in each
 * other's filament. The existing fixtures carry only a `name`, so nothing pinned that it travels.
 *
 * This is the invariant behind a real inverted two-colour print: a body on filament 1 and its
 * embedded logo on filament 2 came off the plate with the colours swapped, because the reorder and
 * the per-part material write disagreed about which volume an ordinal named.
 */
const MATERIAL_SETTINGS_XML = [
  '<config>',
  ' <object id="5">',
  '  <part id="20" subtype="normal_part"><metadata key="name" value="Body"/><metadata key="extruder" value="1"/></part>',
  '  <part id="21" subtype="normal_part"><metadata key="name" value="Logo"/><metadata key="extruder" value="2"/></part>',
  '  <part id="22" subtype="normal_part"><metadata key="name" value="Tab"/><metadata key="extruder" value="2"/></part>',
  ' </object>',
  '</config>'
].join('\n')

/** Each part's `id` paired with its `extruder`, in document order. */
const partExtruders = (settingsXml: string, objectId: number): Array<[number, string]> => {
  const block = new RegExp(`<object\\b[^>]*\\bid="${objectId}"[\\s\\S]*?</object>`).exec(settingsXml)?.[0] ?? ''
  return [...block.matchAll(/<part\b[^>]*\bid="(\d+)"[\s\S]*?key="extruder" value="([^"]*)"/g)]
    .map((match) => [Number(match[1]), match[2] ?? ''] as [number, string])
}

test('a reordered part keeps its own material', () => {
  // Drag the body (ordinal 0) to the end: the sequence becomes Logo, Tab, Body. Each part must
  // arrive carrying the extruder it had, so the body is still filament 1 in its new slot.
  const applied = applyPartLayout(MODEL_XML, MATERIAL_SETTINGS_XML, [], [{ objectId: 5, order: [1, 2, 0] }])
  assert.deepEqual(components(applied.modelXml, 5), [21, 22, 20])
  assert.deepEqual(partExtruders(applied.modelSettingsXml, 5), [[21, '2'], [22, '2'], [20, '1']])
})

test('the component and part lists stay a positional mirror through a reorder', () => {
  // The whole part-scoped bake addresses a volume by its ORDINAL, and it mints that ordinal from
  // the `<component>` list while writing it onto the `<part>` list. The two must therefore agree
  // position for position, or every per-part material, type and override lands one volume off.
  const applied = applyPartLayout(MODEL_XML, MATERIAL_SETTINGS_XML, [], [{ objectId: 5, order: [2, 0, 1] }])
  const partIds = partExtruders(applied.modelSettingsXml, 5).map(([id]) => id)
  assert.deepEqual(components(applied.modelXml, 5), partIds)
})
