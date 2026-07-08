import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NozzleRack, NozzleRackSlot } from '@printstream/shared'
import {
  formatNozzleRackStatus,
  formatNozzleSlotHardware,
  isNozzleRackChanging,
  summarizeNozzleRack
} from './nozzleRackHelpers.js'

function slot(over: Partial<NozzleRackSlot> = {}): NozzleRackSlot {
  return {
    nozzleId: 0,
    onRack: false,
    diameter: '0.4',
    typeCode: null,
    material: 'hardened-steel',
    flow: 'high',
    wear: null,
    loadedFilamentColor: null,
    ...over
  }
}

function rack(over: Partial<NozzleRack> = {}): NozzleRack {
  return {
    status: 'idle',
    position: 'centre',
    replacingFromNozzleId: null,
    replacingToNozzleId: null,
    nozzles: [],
    ...over
  }
}

test('formatNozzleSlotHardware joins diameter, material, and flow', () => {
  assert.equal(formatNozzleSlotHardware(slot()), '0.4 mm · Hardened steel · High flow')
  assert.equal(formatNozzleSlotHardware(slot({ material: null, flow: null, diameter: null, typeCode: 'HH01' })), 'HH01')
  assert.equal(formatNozzleSlotHardware(slot({ material: null, flow: null, diameter: null, typeCode: null })), 'Nozzle')
})

test('summarizeNozzleRack splits mounted from parked and builds the chip label', () => {
  const summary = summarizeNozzleRack(rack({
    nozzles: [
      slot({ nozzleId: 0, onRack: false }),
      slot({ nozzleId: 1, onRack: true }),
      slot({ nozzleId: 2, onRack: true })
    ]
  }))
  assert.equal(summary.mounted.length, 1)
  assert.equal(summary.spares.length, 2)
  assert.equal(summary.changing, false)
  assert.equal(summary.chipLabel, '2 in rack')
})

test('a mid-swap rack reports as changing', () => {
  assert.equal(isNozzleRackChanging(rack({ status: 'pickHotend' })), true)
  assert.equal(isNozzleRackChanging(rack({ status: 'idle' })), false)
  assert.equal(isNozzleRackChanging(rack({ status: 'unknown' })), false)
  assert.equal(summarizeNozzleRack(rack({ status: 'liftHotendRack' })).chipLabel, 'Changing nozzle')
})

test('formatNozzleRackStatus produces friendly labels', () => {
  assert.equal(formatNozzleRackStatus('idle'), 'Idle')
  assert.equal(formatNozzleRackStatus('pickHotend'), 'Picking hotend')
})
