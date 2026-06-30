import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFile } from '@prisma/client'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { mergeAmsMapping, parseAmsMapping, parseRequiredFilaments, resolveQueueableLibraryFile, withUsedGramsFrom } from './store.js'

type FakeRow = Pick<LibraryFile, 'id' | 'name' | 'hidden' | 'origin' | 'deletedAt'>

/** Minimal libraryFile-delegate stub: findFirst honors the `deletedAt: null` scope. */
function fakePrisma(rows: FakeRow[]): AnyPrismaClient {
  return {
    libraryFile: {
      findFirst: async ({ where }: { where: { id: string; deletedAt: null } }) => {
        const row = rows.find((r) => r.id === where.id)
        if (!row) return null
        if (where.deletedAt === null && row.deletedAt != null) return null
        return row
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null
    }
  } as unknown as AnyPrismaClient
}

const rejectingUnhide = async (): Promise<never> => {
  throw new Error('unhide should not be called')
}

test('parseAmsMapping parses a stored tray array, else null', () => {
  assert.deepEqual(parseAmsMapping(JSON.stringify([0, 4, -1])), [0, 4, -1])
  assert.equal(parseAmsMapping(null), null)
  assert.equal(parseAmsMapping('not json'), null)
  assert.equal(parseAmsMapping(JSON.stringify({ not: 'an array' })), null)
})

test('parseRequiredFilaments carries filamentName (brand) and tolerates bad input', () => {
  const json = JSON.stringify([
    { id: 1, filamentType: 'PLA', color: '#FFFFFF', filamentName: 'Bambu' },
    { id: 2, filamentType: 'PETG', color: null }
  ])
  assert.deepEqual(parseRequiredFilaments(json), [
    { id: 1, filamentType: 'PLA', color: '#FFFFFF', filamentName: 'Bambu' },
    { id: 2, filamentType: 'PETG', color: null }
  ])
  assert.deepEqual(parseRequiredFilaments(null), [])
  assert.deepEqual(parseRequiredFilaments('garbage'), [])
})

test('withUsedGramsFrom backfills slice grams onto a material override that omits them, by filament id', () => {
  // A "any printer" override carries identity (type/color/brand) the user chose, but no grams.
  const override = [
    { id: 1, filamentType: 'PETG', color: '#1D7C6A', filamentName: 'Generic' },
    { id: 2, filamentType: 'PLA', color: '#000000', filamentName: 'Bambu' }
  ]
  // The slice (plate inspection) knows the grams per filament slot, regardless of the chosen material.
  const plate = [
    { id: 1, filamentType: 'PLA', color: '#408080', filamentName: 'Bambu', usedGrams: 339.14 },
    { id: 2, filamentType: 'PLA', color: '#000000', filamentName: 'Bambu', usedGrams: null }
  ]
  assert.deepEqual(withUsedGramsFrom(override, plate), [
    { id: 1, filamentType: 'PETG', color: '#1D7C6A', filamentName: 'Generic', usedGrams: 339.14 },
    { id: 2, filamentType: 'PLA', color: '#000000', filamentName: 'Bambu', usedGrams: null }
  ])
  // An override that already carries grams keeps its own; unknown ids and an empty source fall back to null.
  assert.deepEqual(withUsedGramsFrom([{ id: 1, filamentType: 'PLA', color: null, usedGrams: 5 }], plate), [
    { id: 1, filamentType: 'PLA', color: null, usedGrams: 5 }
  ])
  assert.deepEqual(withUsedGramsFrom([{ id: 9, filamentType: 'PLA', color: null }], plate), [
    { id: 9, filamentType: 'PLA', color: null, usedGrams: null }
  ])
})

test('mergeAmsMapping: explicit slots win, -1 auto entries take the computed (matched) slot', () => {
  assert.deepEqual(mergeAmsMapping([0, 4], [2, 3]), [0, 4]) // all explicit → unchanged
  assert.deepEqual(mergeAmsMapping([0, -1], [2, 3]), [0, 3]) // mixed: filament 2 auto → computed
  assert.deepEqual(mergeAmsMapping([-1, -1], [2, 3]), [2, 3]) // all auto → computed
  assert.deepEqual(mergeAmsMapping(null, [2, 3]), [2, 3]) // no override → computed
  assert.deepEqual(mergeAmsMapping([0, 1], undefined), [0, 1]) // no computed → override as-is
  assert.deepEqual(mergeAmsMapping([0], [2, 3]), [0, 3]) // shorter override filled from computed
  assert.equal(mergeAmsMapping(null, undefined), undefined)
  assert.equal(mergeAmsMapping([], undefined), undefined)
})

test('resolveQueueableLibraryFile returns a visible printable file without keeping it', async () => {
  const prisma = fakePrisma([{ id: 'f1', name: 'widget.gcode.3mf', hidden: false, origin: null, deletedAt: null }])
  const file = await resolveQueueableLibraryFile(prisma, 'f1', { unhide: rejectingUnhide })
  assert.equal(file.id, 'f1')
})

test('resolveQueueableLibraryFile keeps a hidden slice output and follows the surviving id', async () => {
  // Keeping folds the hidden output into an existing same-name file, so the survivor id differs.
  const prisma = fakePrisma([
    { id: 'out', name: 'widget.gcode.3mf', hidden: true, origin: 'slice', deletedAt: null },
    { id: 'kept', name: 'widget.gcode.3mf', hidden: false, origin: 'slice', deletedAt: null }
  ])
  let unhidden: string | null = null
  const file = await resolveQueueableLibraryFile(prisma, 'out', {
    unhide: async (id) => {
      unhidden = id
      return { id: 'kept', name: 'widget.gcode.3mf', replacedExisting: true }
    }
  })
  assert.equal(unhidden, 'out')
  assert.equal(file.id, 'kept')
})

test('resolveQueueableLibraryFile rejects recycled, missing, hidden-non-slice, and non-printable files', async () => {
  // Soft-deleted: the deletedAt:null scope hides it.
  await assert.rejects(
    () => resolveQueueableLibraryFile(
      fakePrisma([{ id: 'r', name: 'widget.gcode.3mf', hidden: false, origin: null, deletedAt: new Date() }]),
      'r',
      { unhide: rejectingUnhide }
    ),
    /not found/i
  )
  // Missing id.
  await assert.rejects(() => resolveQueueableLibraryFile(fakePrisma([]), 'missing', { unhide: rejectingUnhide }), /not found/i)
  // Hidden but not a slice output — never auto-kept.
  await assert.rejects(
    () => resolveQueueableLibraryFile(
      fakePrisma([{ id: 'h', name: 'widget.gcode.3mf', hidden: true, origin: 'upload', deletedAt: null }]),
      'h',
      { unhide: rejectingUnhide }
    ),
    /not found/i
  )
  // Visible but not directly printable (unsliced project 3MF).
  await assert.rejects(
    () => resolveQueueableLibraryFile(
      fakePrisma([{ id: 'p', name: 'model.3mf', hidden: false, origin: null, deletedAt: null }]),
      'p',
      { unhide: rejectingUnhide }
    ),
    /can be queued/i
  )
})
