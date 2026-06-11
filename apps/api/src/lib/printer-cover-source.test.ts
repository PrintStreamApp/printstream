import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findBestCoverPathMatch } from './printer-cover-source.js'

test('findBestCoverPathMatch picks the matching printer archive for underscored H2D remote job names', () => {
  const match = findBestCoverPathMatch([
    '/Best Shot Golf - plate_2.gcode.3mf',
    '/Best Shot Golf 0.6mm - plate_1.gcode.3mf',
    '/Best Shot Golf 0.6mm - plate_3.gcode.3mf',
    '/Storage Box - 0.4mm Panchroma.gcode.3mf'
  ], 'Best Shot Golf_plate_3', null)

  assert.equal(match, '/Best Shot Golf 0.6mm - plate_3.gcode.3mf')
})

test('findBestCoverPathMatch refuses unrelated plate matches', () => {
  const match = findBestCoverPathMatch([
    '/Storage Box - plate_3.gcode.3mf',
    '/Another Print - plate_3.gcode.3mf'
  ], 'Best Shot Golf_plate_3', null)

  assert.equal(match, null)
})

test('findBestCoverPathMatch matches externally started PrintStream archives by embedded plate marker', () => {
  const match = findBestCoverPathMatch([
    '/CSM - Bambu - 1 - Housing Parts_ Mount_ Handle.gcode.3mf',
    '/CSM - Bambu - 2 - Mast_ Feeders_ Counter holder_ Mount feet.gcode.3mf'
  ], 'CSM - Bambu - 1 - Housing Parts, Mount, Handle', null)

  assert.equal(match, '/CSM - Bambu - 1 - Housing Parts_ Mount_ Handle.gcode.3mf')
})

test('findBestCoverPathMatch refuses a unique same-plate archive when the job label is unrelated to the project filename', () => {
  const match = findBestCoverPathMatch([
    '/Best Shot Golf - plate_1.gcode.3mf',
    '/Best Shot Golf - plate_2.gcode.3mf',
    '/Best Shot Golf - plate_3.gcode.3mf',
    '/Best Shot Golf - plate_4.gcode.3mf'
  ], 'Tiara', '/data/Metadata/plate_1.gcode')

  assert.equal(match, null)
})