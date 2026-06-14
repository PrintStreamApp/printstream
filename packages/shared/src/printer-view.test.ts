import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultPrinterCardContentSettings,
  printerCardContentSettingsSchema,
  printerViewInputSchema
} from './printer-view.js'

test('printerCardContentSettingsSchema defaults fullWidthSnapshot for older saved views', () => {
  assert.deepEqual(printerCardContentSettingsSchema.parse({
    nozzleTemperatures: true,
    bedTemperature: true,
    chamberTemperature: true,
    printSpeed: true,
    modelThumbnail: true,
    cameraThumbnail: true,
    amsCards: true,
    footerControls: true
  }), defaultPrinterCardContentSettings)
})

test('printerCardContentSettingsSchema preserves an explicit fullWidthSnapshot preference', () => {
  assert.equal(printerCardContentSettingsSchema.parse({
    ...defaultPrinterCardContentSettings,
    fullWidthSnapshot: true
  }).fullWidthSnapshot, true)
})

test('printerViewInputSchema defaults the attribute filters to empty for older saved views', () => {
  const parsed = printerViewInputSchema.parse({ name: 'Shop floor' })
  assert.deepEqual(parsed.modelFilter, [])
  assert.deepEqual(parsed.nozzleDiameterFilter, [])
  assert.deepEqual(parsed.plateTypeFilter, [])
})

test('printerViewInputSchema preserves explicit attribute filters', () => {
  const parsed = printerViewInputSchema.parse({
    name: 'Carbon X1Cs',
    modelFilter: ['X1C', 'P1S'],
    nozzleDiameterFilter: ['0.4', '0.8'],
    plateTypeFilter: ['Textured PEI Plate']
  })
  assert.deepEqual(parsed.modelFilter, ['X1C', 'P1S'])
  assert.deepEqual(parsed.nozzleDiameterFilter, ['0.4', '0.8'])
  assert.deepEqual(parsed.plateTypeFilter, ['Textured PEI Plate'])
})

test('printerViewInputSchema rejects an unknown printer model in the model filter', () => {
  assert.equal(
    printerViewInputSchema.safeParse({ name: 'Bad', modelFilter: ['NOPE'] }).success,
    false
  )
})