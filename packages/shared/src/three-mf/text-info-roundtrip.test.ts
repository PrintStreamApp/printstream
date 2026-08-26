/**
 * Text must survive a SAVE, or the tool is a one-shot: the geometry bakes to triangles and the
 * only record of what was typed is the `<text_info/>` the bake writes into the part's
 * model_settings entry. This walks that whole path -- author, then read back -- because the two
 * halves live in different modules and each has its own way to drop the field silently.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultTextInfo, parseTextInfo, serializeTextInfo } from './text-info.js'
import { parseModelSettingsScene } from './scene-parser.js'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'
import type { SceneEdit } from '../slicing.js'

const INFO = { ...defaultTextInfo('PrintStream', 'DejaVu Sans'), fontSize: 12, thickness: 3, textGap: 0.5 }

/**
 * Run the REAL bake with one text part and return the model_settings it authored.
 *
 * Deliberately not a hand-written fixture: the bake's own call site is exactly where an optional
 * field gets forgotten, and a fixture that pastes `serializeTextInfo` in by hand would pass with
 * the bake ignoring `textInfo` entirely.
 */
function bakedModelSettings(info = INFO): string {
  const source: ThreeMfBakeSource = {
    modelXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter">',
      ' <resources>',
      '  <object id="1" type="model"><mesh><vertices/><triangles/></mesh></object>',
      ' </resources>',
      ' <build><item objectid="1"/></build>',
      '</model>'
    ].join('\n'),
    modelSettingsXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '  <object id="1"><metadata key="name" value="Host"/></object>',
      '</config>'
    ].join('\n'),
    projectSettingsJson: null,
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: new Map(),
    hasBase: true
  }
  const edit = {
    plates: [{ index: 1 }],
    instances: [{
      objectId: 1, plateIndex: 1,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }
    }],
    addedParts: [{
      objectId: 1, meshImportId: 'text-mesh', subtype: 'normal_part', name: 'Text',
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], textInfo: info
    }]
  } as unknown as SceneEdit
  // One degenerate triangle is enough geometry: this test is about the settings document.
  const plan = planEditedThreeMf(source, edit, [{
    importId: 'text-mesh',
    name: 'Text',
    mesh: {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } }
    }
  }])
  return plan.copy?.transforms.get('Metadata/model_settings.config')?.('') ?? ''
}

function modelSettings(): string { return bakedModelSettings() }

test('a text part authored by the bake parses back with its text intact', () => {
  const scene = parseModelSettingsScene(modelSettings())
  const parts = [...scene.partsByObjectId.values()].flatMap((map) => [...map.values()])
  const text = parts.find((part) => part.textInfo)
  assert.ok(text, 'the part carried no textInfo, so the text would reopen as plain geometry')
  assert.equal(text.textInfo?.text, 'PrintStream')
  assert.equal(text.textInfo?.fontName, 'DejaVu Sans')
  assert.equal(text.textInfo?.fontSize, 12)
  assert.equal(text.textInfo?.thickness, 3)
  assert.equal(text.textInfo?.textGap, 0.5)
})

test('a part with no text_info reports none rather than an empty record', () => {
  const scene = parseModelSettingsScene(modelSettings().replace(/ *<text_info[^>]*\/>\n/, ''))
  const parts = [...scene.partsByObjectId.values()].flatMap((map) => [...map.values()])
  assert.equal(parts.length, 1)
  assert.equal(parts[0]?.textInfo, undefined)
})

test('the element sits INSIDE the part, keyed to the volume', () => {
  // BambuStudio's reader resolves text_info against m_curr_config.volume_id, so an element
  // authored at object level would be attached to the wrong thing or rejected outright.
  const xml = modelSettings()
  const part = /<part\b[\s\S]*?<\/part>/.exec(xml)?.[0] ?? ''
  assert.ok(part.includes('<text_info'), 'text_info was not written inside its part')
})

test('text containing quotes survives the file, not just the serializer', () => {
  const quoted = { ...INFO, text: 'He said "hi" & left' }
  const xml = modelSettings().replace(serializeTextInfo(INFO), serializeTextInfo(quoted))
  const scene = parseModelSettingsScene(xml)
  const parts = [...scene.partsByObjectId.values()].flatMap((map) => [...map.values()])
  assert.equal(parts[0]?.textInfo?.text, 'He said "hi" & left')
})

test('the serializer and parser agree on every field, through the file', () => {
  const roundTripped = parseTextInfo(serializeTextInfo(INFO))
  assert.deepEqual(roundTripped, INFO)
})
