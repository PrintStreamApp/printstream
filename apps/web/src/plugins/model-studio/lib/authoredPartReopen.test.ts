/**
 * A part authored by a TOOL must stay re-editable across a close, not merely within the session
 * that made it.
 *
 * This pins the hop that was missing. `<text_info>` was written into the 3MF, parsed back by the
 * scene parser, and carried to the browser on the scene DTO (which says so in place,
 * `printer-contracts.ts`: "a scene field missing from this DTO ... silently never reaches the
 * browser") -- and then `instanceFromScene` dropped it, because `EditorInstancePart` had no field
 * to put it in. So six hops worked, the seventh did not, and reopening a saved project turned every
 * text part back into anonymous solids with nothing logged anywhere.
 *
 * It is a cheap test guarding an expensive-to-notice failure: nothing throws, nothing warns, and
 * the only symptom is a tool that declines to open on a part it authored last week.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { libraryThreeMfSceneSchema, sceneEditSchema, threeMfIndexSchema } from '@printstream/shared'
import { defaultTextInfo } from '@printstream/shared/three-mf'
import * as THREE from 'three'
import {
  cloneEditorState,
  planSvgReextrude,
  resolveSvgArchiveEntry,
  seedEditorState,
  svgArtworkParts,
  type SvgArtworkPart
} from './editorModel.js'

const IDENTITY_3MF = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

const TEXT_INFO = { ...defaultTextInfo('PrintStream', 'DejaVu Sans'), fontSize: 12, thickness: 3 }

const SVG_PART = {
  entryPath: '3D/logo.svg',
  fileName: 'logo.svg',
  pieceIndex: 2,
  widthMm: 40,
  thickness: 1.6,
  includeBackground: false
}

/** A saved project holding one object whose two volumes were authored by the text and SVG tools. */
const scene = () => libraryThreeMfSceneSchema.parse({
  plateIndex: 1,
  plateName: null,
  bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, plateType: null },
  parts: [{
    entryPath: '/3D/Objects/object_1.model', objectId: 1, transform: IDENTITY_3MF,
    name: 'Host', sourceFile: null, filamentId: 1, filamentName: null, color: null
  }],
  instances: [{
    objectId: 1, instanceId: 0, name: 'Host', transform: IDENTITY_3MF,
    filamentId: 1, filamentName: null, color: null,
    parts: [
      {
        entryPath: '/3D/Objects/object_1.model', componentObjectId: 1, transform: IDENTITY_3MF,
        textInfo: TEXT_INFO
      },
      {
        entryPath: '/3D/Objects/object_1.model', componentObjectId: 2, transform: IDENTITY_3MF,
        svgPart: SVG_PART
      },
      { entryPath: '/3D/Objects/object_1.model', componentObjectId: 3, transform: IDENTITY_3MF }
    ]
  }]
})

const index = () => threeMfIndexSchema.parse({
  plates: [{ index: 1, name: null, hasThumbnail: false, plateType: null, nozzleSizes: [], filaments: [], objects: [] }],
  projectFilaments: [],
  compatiblePrinterModels: []
})

function partsOfSeededState() {
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  return state.plates[0]?.instances[0]?.parts ?? []
}

test('a saved TEXT part reaches the editor still carrying what it was typed from', () => {
  const parts = partsOfSeededState()
  assert.equal(parts.length, 3)
  assert.deepEqual(parts[0]?.textInfo, TEXT_INFO,
    'textInfo died at instanceFromScene, so the text tool cannot reopen a saved part')
})

test('a saved SVG part reaches the editor still carrying what it was extruded from', () => {
  assert.deepEqual(partsOfSeededState()[1]?.svgPart, SVG_PART,
    'svgPart died at instanceFromScene, so the SVG tool cannot reopen a saved part')
})

test('an ordinary part carries neither record rather than an empty one', () => {
  // The tools decide whether a part is theirs by the record's PRESENCE, so an empty object here
  // would make the text tool adopt an imported solid and rewrite it as letterforms.
  const plain = partsOfSeededState()[2]
  assert.equal(plain?.textInfo, undefined)
  assert.equal(plain?.svgPart, undefined)
})

test('the records are addressed by ORDINAL, not by the mesh id they happen to share', () => {
  // A part is keyed by its position in the object's component list; BambuStudio deliberately writes
  // one `componentObjectId` for every volume sharing a mesh, so an object can hold several parts
  // with the same id. Keying a record by that id would put a reopen on the wrong volume.
  const parts = partsOfSeededState()
  assert.equal(parts[0]?.partIndex, 0)
  assert.equal(parts[1]?.partIndex, 1)
  assert.ok(parts[1]?.svgPart, 'the second volume\'s record must land on the second volume')
  assert.equal(parts[0]?.svgPart, undefined)
})

test('a new artwork never reuses an entry name the opened file already holds', () => {
  // The bytes behind a baked part live in the ARCHIVE, not in `svgSources`, so their entry names are
  // visible only through the records that reference them. Minting against the session alone let a
  // new `logo.svg` take the existing one's name: an appended entry never displaces one the copy pass
  // already wrote, so the new markup was dropped and the new part reopened as the OLD drawing.
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  const resolved = resolveSvgArchiveEntry(state, 'logo.svg', '<svg>new</svg>')
  assert.equal(resolved.reused, false)
  assert.notEqual(resolved.entryPath, SVG_PART.entryPath)
  assert.equal(resolved.entryPath, '3D/logo_2.svg')
})

test('identical bytes reuse their entry instead of storing a second copy', () => {
  // Adding one artwork to several objects is ordinary; keying on the name alone wrote a
  // byte-identical copy per repeat, into the save payload and the stored file both.
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  state.svgSources = { '3D/logo.svg': '<svg>same</svg>' }
  const resolved = resolveSvgArchiveEntry(state, 'logo.svg', '<svg>same</svg>')
  assert.equal(resolved.reused, true)
  assert.equal(resolved.entryPath, '3D/logo.svg')
})

test('an entry named by a session-added part is taken too', () => {
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  state.addedParts = { 1: [{ svgPart: { ...SVG_PART, entryPath: '3D/badge.svg' } } as never] }
  assert.notEqual(resolveSvgArchiveEntry(state, 'badge.svg', '<svg>x</svg>').entryPath, '3D/badge.svg')
})

test('an SVG source entry must be an svg under 3D/, and must not traverse', () => {
  // The bake writes this verbatim as an archive entry name and both writers key entries last-wins,
  // so an unconstrained value lets a save replace `3D/3dmodel.model` with arbitrary text.
  const entry = (entryPath: string) =>
    sceneEditSchema.safeParse({
      plates: [{ index: 1 }],
      instances: [],
      svgSources: [{ entryPath, markup: '<svg/>' }]
    }).success
  assert.equal(entry('3D/logo.svg'), true)
  assert.equal(entry('3D/3dmodel.model'), false)
  assert.equal(entry('Metadata/model_settings.config'), false)
  assert.equal(entry('3D/../Metadata/evil.svg'), false)
  assert.equal(entry('3d/logo.svg'), false, 'Studio\'s own test is case-sensitive')
})

test('an undo snapshot keeps every authoring record and the artwork behind it', () => {
  // `cloneEditorState` rebuilds parts field by field, so a record with no field named there is
  // dropped by every undo/redo AND by the single-object export, which both go through it. That took
  // a saved text part back to anonymous solids while it sat on screen looking unchanged, and made
  // the next save write no record at all. The `svgSources` half is worse than a plain loss: the
  // parts keep records NAMING bytes the state no longer holds, which saves a dangling reference.
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  state.svgSources = { '3D/logo.svg': '<svg>art</svg>' }
  state.addedParts = {
    1: [{ key: 'k1', importId: 'i1', subtype: 'normal_part', name: 'Logo 2',
      position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
      soup: new Float32Array(9), svgPart: SVG_PART, textInfo: TEXT_INFO } as never]
  }

  const clone = cloneEditorState(state)

  assert.deepEqual(clone.plates[0]?.instances[0]?.parts[0]?.textInfo, TEXT_INFO)
  assert.deepEqual(clone.plates[0]?.instances[0]?.parts[1]?.svgPart, SVG_PART)
  assert.deepEqual(clone.addedParts?.[1]?.[0]?.svgPart, SVG_PART)
  assert.deepEqual(clone.addedParts?.[1]?.[0]?.textInfo, TEXT_INFO)
  assert.deepEqual(clone.svgSources, { '3D/logo.svg': '<svg>art</svg>' })
})

test('an artwork\'s parts are collected across BOTH address spaces', () => {
  // Re-extruding replaces every piece of the drawing, and a piece may be a baked part from the file
  // or a volume added this session. Collecting only one kind would leave the other showing the old
  // geometry beside the new, which reads as the tool half-working.
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  state.addedParts = {
    1: [{ key: 'k1', svgPart: { ...SVG_PART, pieceIndex: 5 } } as never]
  }
  const parts = svgArtworkParts(state, 1, SVG_PART.entryPath)
  assert.equal(parts.length, 2)
  assert.deepEqual(parts.map((p) => p.kind).sort(), ['added', 'baked'])
  assert.deepEqual(parts.map((p) => p.pieceIndex).sort(), [2, 5])
})

test('only SURVIVING pieces are collected, so a re-extrude cannot resurrect a deleted one', () => {
  // The set comes from the parts that still exist, never from re-reading the artwork: otherwise
  // changing a width would bring back the background the user excluded and every mark they removed.
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  assert.equal(svgArtworkParts(state, 1, SVG_PART.entryPath).length, 1)
  assert.equal(svgArtworkParts(state, 1, '3D/never-imported.svg').length, 0)
})

test('artwork on another object is not collected', () => {
  // The same file added to two models is two independent artworks that share an archive entry;
  // editing one must not reach into the other.
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  assert.equal(svgArtworkParts(state, 999, SVG_PART.entryPath).length, 0)
})

test('a baked piece carries the transform its replacement must land on', () => {
  // A width change must not also move the artwork, so the replacement inherits the original's
  // placement rather than being re-placed from scratch.
  const part = svgArtworkParts(seedEditorState(index(), new Map([[1, scene()]])), 1, SVG_PART.entryPath)[0]
  assert.equal(part?.kind, 'baked')
  assert.deepEqual(part?.kind === 'baked' ? part.transform : null, IDENTITY_3MF)
})

test('an object on two plates yields each of its parts ONCE', () => {
  // Baked parts are object-level, so one matching instance describes them all. Returning the same
  // part per instance made the re-extrude push two replacements for one removal (the removal set is
  // a Set of ordinals), doubling the geometry, and offered to update twice as many parts as exist.
  const twoPlates = seedEditorState(
    threeMfIndexSchema.parse({
      plates: [1, 2].map((i) => ({
        index: i, name: null, hasThumbnail: false, plateType: null,
        nozzleSizes: [], filaments: [], objects: []
      })),
      projectFilaments: [],
      compatiblePrinterModels: []
    }),
    new Map([[1, scene()], [2, scene()]])
  )
  const parts = svgArtworkParts(twoPlates, 1, SVG_PART.entryPath)
  assert.equal(parts.length, 1, 'the same baked part must not be collected once per plate')
})

test('a baked piece carries its OWN material, not its object\'s', () => {
  // A re-extrude inherits this. Reading the instance's instead repainted every mark to the object's
  // colour, so changing a width silently undid per-part material assignments.
  const part = svgArtworkParts(seedEditorState(index(), new Map([[1, scene()]])), 1, SVG_PART.entryPath)[0]
  assert.equal(part?.kind, 'baked')
  assert.ok(part?.kind === 'baked' && 'filamentId' in part, 'the part must carry its own filamentId')
})

test('an ORPHANED archive entry is still taken', () => {
  // Artwork whose parts were all deleted keeps its entry (the copy pass carries it), and an appended
  // entry never displaces one already written -- so reusing that name discards the new bytes and the
  // new part reopens as the old drawing. Records alone cannot see it; the archive listing can.
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  const resolved = resolveSvgArchiveEntry(state, 'orphan.svg', '<svg>new</svg>', ['3D/orphan.svg'])
  assert.notEqual(resolved.entryPath, '3D/orphan.svg')
  assert.equal(resolved.entryPath, '3D/orphan_2.svg')
})

test('non-svg archive entries never constrain the name', () => {
  const state = seedEditorState(index(), new Map([[1, scene()]]))
  const resolved = resolveSvgArchiveEntry(
    state, 'fresh.svg', '<svg>x</svg>', ['3D/3dmodel.model', 'Metadata/model_settings.config']
  )
  assert.equal(resolved.entryPath, '3D/fresh.svg')
})

/**
 * The re-extrude cases a replace-only pass got silently wrong. None is reachable from the happy path
 * of "same file, different width", which is why they all survived a browser test of that path.
 */
const baked = (pieceIndex: number): SvgArtworkPart =>
  ({ kind: 'baked', partIndex: pieceIndex, pieceIndex, transform: IDENTITY_3MF, subtype: null, filamentId: 1 })

test('turning the background ON adds the piece rather than doing nothing', () => {
  // The checkbox was rendered, honoured by the extrusion, and then ignored: no survivor carried the
  // backdrop's index, so it was never added and the commit reported success.
  const plan = planSvgReextrude([baked(2), baked(3)], [1, 2, 3], true)
  assert.deepEqual(plan.add, [1], 'the backdrop must be added')
  assert.equal(plan.replace.length, 2)
  assert.equal(plan.remove.length, 0)
})

test('turning the background OFF removes its part rather than leaving old geometry', () => {
  // Worse than a no-op: the part stayed in the model showing the shape the user just excluded.
  const plan = planSvgReextrude([baked(1), baked(2), baked(3)], [2, 3], true)
  assert.deepEqual(plan.remove.map((p) => p.pieceIndex), [1])
  assert.equal(plan.replace.length, 2)
  assert.equal(plan.add.length, 0)
})

test('a merged artwork replaced by a split one renumbers instead of matching nothing', () => {
  // A merged import records piece 0; a split extrusion produces 1..N. Keyed naively the survivor
  // matched no piece at all, so the whole update failed with "none of the pieces are still here".
  const plan = planSvgReextrude([baked(0)], [1, 2, 3], true)
  assert.equal(plan.replace.length, 0)
  assert.deepEqual(plan.add, [1, 2, 3])
  assert.deepEqual(plan.remove.map((p) => p.pieceIndex), [0])
})

test('a split artwork replaced by a merged one collapses to one part', () => {
  const plan = planSvgReextrude([baked(1), baked(2), baked(3)], [1], false)
  assert.equal(plan.replace.length, 0, 'no survivor records piece 0')
  assert.deepEqual(plan.add, [1])
  assert.equal(plan.remove.length, 3)
})

test('a merged re-extrude of merged artwork replaces in place', () => {
  const plan = planSvgReextrude([baked(0)], [1], false)
  assert.equal(plan.replace.length, 1)
  assert.equal(plan.replace[0]?.survivor.pieceIndex, 0)
  assert.equal(plan.add.length, 0)
  assert.equal(plan.remove.length, 0)
})

test('a replaced file with more shapes adds only the new ones', () => {
  const plan = planSvgReextrude([baked(1), baked(2)], [1, 2, 3, 4], true)
  assert.equal(plan.replace.length, 2)
  assert.deepEqual(plan.add, [3, 4])
  assert.equal(plan.remove.length, 0)
})

test('a piece the user deleted is NOT resurrected', () => {
  // The survivor set is the parts that still exist, so a deleted mark simply has no survivor and is
  // not re-added -- the whole reason the set is not re-derived from the artwork.
  const plan = planSvgReextrude([baked(1), baked(3)], [1, 3], true)
  assert.equal(plan.add.length, 0)
  assert.equal(plan.replace.length, 2)
})
