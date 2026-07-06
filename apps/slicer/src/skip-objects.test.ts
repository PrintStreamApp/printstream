import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSkipObjectsArgs, skipObjectIdentifyIdsFromXml } from './skip-objects.js'

// A 3dmodel.model build section: object 27 stays printable, 81 + 126 are deselected (printable="0").
const MODEL_XML = [
  '<model><resources/><build>',
  '  <item objectid="27" p:UUID="0000001b-0000-0000-0000-000000000000" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>',
  '  <item objectid="81" p:UUID="00000051-0000-0000-0000-000000000000" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="0"/>',
  '  <item objectid="126" p:UUID="0000007e-0000-0000-0000-000000000000" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="0"/>',
  '</build></model>'
].join('\n')

// model_settings maps each object_id to its instance identify_id (the value --skip-objects keys on).
const SETTINGS_XML = [
  '<config><plate>',
  '  <metadata key="plater_id" value="1"/>',
  '  <model_instance><metadata key="object_id" value="27"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="3683"/></model_instance>',
  '  <model_instance><metadata key="object_id" value="81"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="4001"/></model_instance>',
  '  <model_instance><metadata key="object_id" value="126"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="4266"/></model_instance>',
  '</plate></config>'
].join('\n')

test('skipObjectIdentifyIdsFromXml maps printable="0" build items to their identify_ids', () => {
  assert.deepEqual(skipObjectIdentifyIdsFromXml(MODEL_XML, SETTINGS_XML), [4001, 4266])
})

test('skipObjectIdentifyIdsFromXml returns nothing when every build item is printable', () => {
  const allPrintable = MODEL_XML.replace(/printable="0"/g, 'printable="1"')
  assert.deepEqual(skipObjectIdentifyIdsFromXml(allPrintable, SETTINGS_XML), [])
})

test('skipObjectIdentifyIdsFromXml skips all instances of an unprintable object', () => {
  // object 81 has two instances; both identify_ids must be skipped.
  const twoInstances = SETTINGS_XML.replace(
    '</plate></config>',
    '  <model_instance><metadata key="object_id" value="81"/><metadata key="instance_id" value="1"/><metadata key="identify_id" value="4002"/></model_instance>\n</plate></config>'
  )
  assert.deepEqual(skipObjectIdentifyIdsFromXml(MODEL_XML, twoInstances).sort((a, b) => a - b), [4001, 4002, 4266])
})

test('skipObjectIdentifyIdsFromXml skips only the toggled instance of a mixed object', () => {
  // The editor's per-INSTANCE Printable toggle: object 81 has two build items (instance-id
  // order), only the SECOND is unprintable — so only identify_id 4002 is skipped.
  const mixedModel = MODEL_XML.replace(
    '  <item objectid="126" p:UUID="0000007e-0000-0000-0000-000000000000" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="0"/>',
    [
      '  <item objectid="81" p:UUID="00000052-0000-0000-0000-000000000000" transform="1 0 0 0 1 0 0 0 1 20 0 0" printable="0"/>',
      '  <item objectid="126" p:UUID="0000007e-0000-0000-0000-000000000000" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>'
    ].join('\n')
  ).replace(
    '  <item objectid="81" p:UUID="00000051-0000-0000-0000-000000000000" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="0"/>',
    '  <item objectid="81" p:UUID="00000051-0000-0000-0000-000000000000" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>'
  )
  const twoInstances = SETTINGS_XML.replace(
    '</plate></config>',
    '  <model_instance><metadata key="object_id" value="81"/><metadata key="instance_id" value="1"/><metadata key="identify_id" value="4002"/></model_instance>\n</plate></config>'
  )
  assert.deepEqual(skipObjectIdentifyIdsFromXml(mixedModel, twoInstances), [4002])
})

test('buildSkipObjectsArgs formats the CLI flag, or nothing when empty', () => {
  assert.deepEqual(buildSkipObjectsArgs([4001, 4266]), ['--skip-objects', '4001,4266'])
  assert.deepEqual(buildSkipObjectsArgs([]), [])
})
