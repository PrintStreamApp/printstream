/**
 * The clone pre-pass must resolve EVERY object-keyed seam's negative placeholder.
 *
 * `applyObjectClones` runs before every other edit and rewrites each independent copy's negative
 * placeholder into the real object id it minted. Any seam it forgets keeps the placeholder, and
 * nothing downstream treats that as an error: the appliers look the id up, miss, and skip. So a
 * missed seam is not a crash, it is the user's edit quietly not happening, discovered days later.
 *
 * That has now happened three times in this file's history (`heightRanges`, `layerHeightProfiles`,
 * `removedParts`), which is why the check is mechanical rather than a convention. The first test
 * derives the list of object-keyed seams FROM THE SCHEMA, so adding one to `sceneEditSchema`
 * without listing it here fails the build; the second proves each listed seam actually resolves.
 *
 * Adding an object-keyed seam is therefore: the schema member, its applier, a line in
 * `applyObjectClones`, and one entry in `PLACEHOLDER_SEAM_ENTRIES` below.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { sceneEditSchema } from '../slicing.js'
import { applyObjectClones } from './object-clone.js'
import type { SceneEdit } from '../slicing.js'

/** The placeholder every entry below addresses; the pre-pass must leave none of these behind. */
const PLACEHOLDER = -1
const SOURCE_OBJECT_ID = 3

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model>',
  '  <resources>',
  '    <object id="3" type="model">',
  '      <mesh><vertices/><triangles/></mesh>',
  '    </object>',
  '  </resources>',
  '  <build>',
  '    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>',
  '  </build>',
  '</model>'
].join('\n')

const MODEL_SETTINGS_XML = [
  '<config>',
  '  <object id="3"><metadata key="name" value="Box"/><part id="1" subtype="normal_part"><metadata key="name" value="Box part"/></part></object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
  '  </plate>',
  '</config>'
].join('\n')

/**
 * One minimally-valid entry per object-keyed seam, each addressing {@link PLACEHOLDER}.
 *
 * Hand-written rather than generated because the seams genuinely differ in shape; the enumeration
 * test below is what stops the list going stale.
 */
const PLACEHOLDER_SEAM_ENTRIES: Record<string, unknown[]> = {
  partFilaments: [{ objectId: PLACEHOLDER, partIndex: 0, filamentId: 1 }],
  partProcessOverrides: [{ objectId: PLACEHOLDER, partIndex: 0, settings: { wall_loops: '3' } }],
  partTypeChanges: [{ objectId: PLACEHOLDER, partIndex: 0, subtype: 'modifier_part' }],
  partTransforms: [{ objectId: PLACEHOLDER, partIndex: 0, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }],
  removedParts: [{ objectId: PLACEHOLDER, partIndex: 0 }],
  supportPaint: [{ objectId: PLACEHOLDER, componentObjectId: 1, triangles: { '0': '8' } }],
  seamPaint: [{ objectId: PLACEHOLDER, componentObjectId: 1, triangles: { '0': '8' } }],
  colorPaint: [{ objectId: PLACEHOLDER, componentObjectId: 1, triangles: { '0': '8' } }],
  fuzzyPaint: [{ objectId: PLACEHOLDER, componentObjectId: 1, triangles: { '0': '8' } }],
  brimEars: [{ objectId: PLACEHOLDER, ears: [{ x: 0, y: 0, z: 0, radius: 5 }] }],
  heightRanges: [{ objectId: PLACEHOLDER, ranges: [{ minZ: 0, maxZ: 2, settings: { layer_height: '0.1' } }] }],
  layerHeightProfiles: [{ objectId: PLACEHOLDER, profile: [0, 0.2, 10, 0.2] }],
  objectNames: [{ objectId: PLACEHOLDER, name: 'Copy' }],
  addedParts: [{ objectId: PLACEHOLDER, meshImportId: 'imp-x', subtype: 'modifier_part', name: 'Blocker', matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }],
  repairedObjectIds: [PLACEHOLDER]
}

/**
 * Object-keyed members the pre-pass deliberately does NOT remap, each with the reason. An
 * exclusion is a claim, so it belongs here where it is read next to the check rather than being a
 * silent omission from the list.
 */
const EXCLUDED_SEAMS = new Set([
  // The placement list, not a sidecar: remapped by its own dedicated branch above.
  'instances',
  // The declaration being resolved.
  'objectClones',
  // Deliberately left in the REQUEST's id space. `bake.ts` turns it into
  // `{ originalObjectId, bakedObjectId }` and hands it to `rekeyObjectProcessOverrides` AHEAD of
  // `clonedObjectIds`; that helper applies moves in order and deletes each source key. For a
  // replaced COPY the chain has to read placeholder -> replacement, so the entry must still name
  // the placeholder: remapping it to the clone's id would make the pair read
  // `[{clone -> replacement}, {placeholder -> clone}]`, which strands the copy's per-object
  // process overrides on the clone id instead of moving them onto the object that was baked.
  'meshReplacements'
])

/** Which `sceneEditSchema` members are keyed by an object id (and so must be remapped). */
function objectKeyedSeams(): string[] {
  const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny => (
    schema instanceof z.ZodOptional || schema instanceof z.ZodNullable ? unwrap(schema.unwrap()) : schema
  )
  // `sceneEditSchema` carries a `superRefine`, so it is a ZodEffects wrapping the object.
  const root = sceneEditSchema instanceof z.ZodEffects ? sceneEditSchema.innerType() : sceneEditSchema
  const shape = (root as z.ZodObject<z.ZodRawShape>).shape
  const seams: string[] = []
  for (const [key, raw] of Object.entries(shape)) {
    if (EXCLUDED_SEAMS.has(key)) continue
    const inner = unwrap(raw as z.ZodTypeAny)
    if (!(inner instanceof z.ZodArray)) continue
    const element = unwrap(inner.element as z.ZodTypeAny)
    // `repairedObjectIds` is a bare number array of object ids; the rest are objects with an
    // `objectId` field.
    if (key === 'repairedObjectIds') { seams.push(key); continue }
    const shape = element instanceof z.ZodObject ? element.shape : null
    if (shape && 'objectId' in shape) seams.push(key)
  }
  return seams
}

test('every object-keyed SceneEdit seam is listed for the clone pre-pass', () => {
  // Derived from the schema, so a new seam fails here rather than silently skipping the pre-pass
  // and losing the user's edit on any independent copy.
  const missing = objectKeyedSeams().filter((seam) => !(seam in PLACEHOLDER_SEAM_ENTRIES))
  assert.deepEqual(
    missing,
    [],
    `New object-keyed SceneEdit seam(s) with no clone-pre-pass coverage: ${missing.join(', ')}. `
    + 'Add the remap in applyObjectClones and an entry in PLACEHOLDER_SEAM_ENTRIES.'
  )
})

test('the clone pre-pass leaves no placeholder behind in any seam', () => {
  const edit = {
    plates: [{ index: 1 }],
    instances: [
      { objectId: SOURCE_OBJECT_ID, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      { objectId: PLACEHOLDER, plateIndex: 1, position: { x: 40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
    ],
    objectClones: [{ objectId: PLACEHOLDER, sourceObjectId: SOURCE_OBJECT_ID }],
    ...PLACEHOLDER_SEAM_ENTRIES
  } as unknown as SceneEdit

  const result = applyObjectClones(MODEL_XML, MODEL_SETTINGS_XML, edit, 100, null)

  // Walk the WHOLE resolved edit: any surviving placeholder is a seam the pre-pass forgot, and
  // naming it is the difference between a one-line fix and an afternoon of bisecting a save.
  const offenders: string[] = []
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((entry, i) => walk(entry, `${path}[${i}]`)); return }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) walk(entry, path ? `${path}.${key}` : key)
      return
    }
    if (value === PLACEHOLDER && /objectId|repairedObjectIds/i.test(path)) offenders.push(path)
  }
  walk(result.edit, '')
  assert.deepEqual(offenders, [], `seams still naming the clone placeholder: ${offenders.join(', ')}`)
})
