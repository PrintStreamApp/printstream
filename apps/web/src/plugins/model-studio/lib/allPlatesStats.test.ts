import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreeMfIndex } from '@printstream/shared'
import { aggregatePlateFilaments, platePrintedGrams, summarizeAllPlates } from './allPlatesStats'

type Plate = ThreeMfIndex['plates'][number]
type PlateFilament = Plate['filaments'][number]
type ProjectFilament = ThreeMfIndex['projectFilaments'][number]

function plateFilament(partial: Partial<PlateFilament> & { id: number }): PlateFilament {
  return {
    filamentType: 'PLA',
    filamentName: null,
    color: null,
    nozzleId: null,
    nozzleDiameter: null,
    chamberTemperature: null,
    usedGrams: null,
    usedMeters: null,
    ...partial
  }
}

function plate(partial: Partial<Plate> & { index: number }): Plate {
  return {
    name: null,
    hasThumbnail: false,
    plateType: null,
    nozzleSizes: [],
    filaments: [],
    objects: [],
    ...partial
  }
}

function projectFilament(partial: Partial<ProjectFilament> & { id: number }): ProjectFilament {
  return {
    filamentType: 'PLA',
    filamentName: null,
    color: null,
    nozzleId: null,
    chamberTemperature: null,
    ...partial
  }
}

test('one slot used on several plates is ONE row, summed', () => {
  const plates = [
    plate({ index: 1, prediction: 100, weight: 10, filaments: [plateFilament({ id: 1, usedGrams: 10, usedMeters: 3 })] }),
    plate({ index: 2, prediction: 200, weight: 25, filaments: [plateFilament({ id: 1, usedGrams: 25, usedMeters: 8 })] })
  ]
  const rows = aggregatePlateFilaments(plates, [projectFilament({ id: 1, filamentName: 'Bambu PLA Basic' })])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.grams, 35)
  assert.equal(rows[0]!.meters, 11)
  assert.equal(rows[0]!.label, 'Bambu PLA Basic')
})

test('two slots holding the SAME material stay separate rows', () => {
  // They are separate spools; merging them by label would report one where the plate loads two.
  const plates = [plate({
    index: 1,
    filaments: [
      plateFilament({ id: 1, filamentName: 'Bambu PLA Basic', usedGrams: 10 }),
      plateFilament({ id: 2, filamentName: 'Bambu PLA Basic', usedGrams: 4 })
    ]
  })]
  const rows = aggregatePlateFilaments(plates, [])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.id), [1, 2])
})

test('cost is money per KILOGRAM applied to grams used, and absent when unpriced', () => {
  const plates = [plate({ index: 1, filaments: [
    plateFilament({ id: 1, usedGrams: 500 }),
    plateFilament({ id: 2, usedGrams: 500 })
  ] })]
  const rows = aggregatePlateFilaments(plates, [
    projectFilament({ id: 1, costPerKg: 24.99 }),
    projectFilament({ id: 2, costPerKg: 0 })
  ])
  assert.ok(Math.abs(rows[0]!.cost! - 12.495) < 1e-9, '500g at 24.99/kg')
  assert.equal(rows[1]!.cost, null, 'a zero price is "not priced", not a cost of zero')
})

test('a project that priced nothing reports no total cost at all', () => {
  // Null rather than 0 so the window drops the column instead of claiming the project is free.
  const plates = [plate({ index: 1, filaments: [plateFilament({ id: 1, usedGrams: 100 })] })]
  const rows = aggregatePlateFilaments(plates, [projectFilament({ id: 1 })])
  assert.equal(summarizeAllPlates(plates, rows).cost, null)
})

test('an unsliced plate is counted and named but contributes nothing', () => {
  // `prediction`/`weight`/`usedGrams` come from slice_info, which only a sliced plate carries.
  const plates = [
    plate({ index: 1, prediction: 600, filaments: [plateFilament({ id: 1, usedGrams: 20, usedMeters: 6 })] }),
    plate({ index: 2, prediction: null, filaments: [] })
  ]
  const rows = aggregatePlateFilaments(plates, [])
  const totals = summarizeAllPlates(plates, rows)
  assert.equal(totals.seconds, 600)
  assert.equal(totals.grams, 20)
  assert.equal(totals.unslicedPlates, 1)
})

test('the label does not depend on which plate mentioned the slot first', () => {
  // A label assembled from "whichever field happened to be set" renders one material two ways in
  // one list, which reads as two materials. The plates DISAGREE here on purpose: one names the
  // slot and the other does not. An earlier version resolved the label from whichever plate came
  // first, so reversing the plate order renamed the material.
  const namedFirst = [
    plate({ index: 1, filaments: [plateFilament({ id: 1, filamentName: 'PolyLite PLA', usedGrams: 1 })] }),
    plate({ index: 2, filaments: [plateFilament({ id: 1, filamentName: null, usedGrams: 1 })] })
  ]
  const namedSecond = [namedFirst[1]!, namedFirst[0]!]
  // With no project name to fall back on, the plate that DID name the slot must win either way.
  assert.equal(aggregatePlateFilaments(namedFirst, [])[0]!.label, 'PolyLite PLA')
  assert.equal(aggregatePlateFilaments(namedSecond, [])[0]!.label, 'PolyLite PLA')

  // And the project slot outranks both, since it is the one description that does not vary.
  const project = [projectFilament({ id: 1, filamentName: 'Bambu PLA Basic' })]
  assert.equal(aggregatePlateFilaments(namedFirst, project)[0]!.label, 'Bambu PLA Basic')
  assert.equal(aggregatePlateFilaments(namedSecond, project)[0]!.label, 'Bambu PLA Basic')
})

test('a plate weighs what its own row shows, and the rows add up to the footer', () => {
  // The two records are independent and separately nullable, so a table that renders one and totals
  // the other does not add up: plate weights under a 0.0 g total, or "-" rows under a real total.
  const plates = [
    // Per-filament grams only.
    plate({ index: 1, filaments: [plateFilament({ id: 1, usedGrams: 12 }), plateFilament({ id: 2, usedGrams: 8 })] }),
    // Plate-level weight only, which must still count rather than reading as "-".
    plate({ index: 2, weight: 31.5 }),
    // Neither: nothing to show and nothing to add.
    plate({ index: 3 })
  ]
  assert.equal(platePrintedGrams(plates[0]!), 20)
  assert.equal(platePrintedGrams(plates[1]!), 31.5)
  assert.equal(platePrintedGrams(plates[2]!), null)

  const totals = summarizeAllPlates(plates, aggregatePlateFilaments(plates, []))
  assert.equal(totals.plateGrams, 51.5, 'the footer is the sum of exactly what the column renders')
})

test('per-filament grams win over the plate weight, so the plate agrees with the material table', () => {
  // A plate carrying both must not be counted twice, and the figure shown has to be the one the
  // Material table above could also produce.
  const both = plate({ index: 1, weight: 99, filaments: [plateFilament({ id: 1, usedGrams: 40 })] })
  assert.equal(platePrintedGrams(both), 40)
})
