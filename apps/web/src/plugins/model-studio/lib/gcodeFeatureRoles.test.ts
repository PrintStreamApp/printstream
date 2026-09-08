/**
 * Pins the named roles to the palette they index into. This is the whole reason the map is derived
 * rather than written out: the bug it replaced was six bare integers in another module going stale
 * when one entry moved, with nothing failing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GCODE_FEATURE_NAMES, GCODE_FEATURE_ROLES } from './gcodeFeatureRoles'

test('every named role indexes the label it is named for', () => {
  const expected: Record<keyof typeof GCODE_FEATURE_ROLES, string> = {
    other: 'Other',
    innerWall: 'Inner wall',
    outerWall: 'Outer wall',
    overhangWall: 'Overhang wall',
    sparseInfill: 'Sparse infill',
    internalSolidInfill: 'Internal solid infill',
    topSurface: 'Top surface',
    bottomSurface: 'Bottom surface',
    ironing: 'Ironing',
    bridge: 'Bridge',
    gapInfill: 'Gap infill',
    skirt: 'Skirt',
    brim: 'Brim',
    support: 'Support',
    supportInterface: 'Support interface',
    primeTower: 'Prime tower',
    custom: 'Custom',
    flush: 'Flush'
  }
  for (const [role, label] of Object.entries(expected)) {
    assert.equal(
      GCODE_FEATURE_NAMES[GCODE_FEATURE_ROLES[role as keyof typeof GCODE_FEATURE_ROLES]],
      label,
      `${role} must index "${label}"`
    )
  }
})

test('the map covers the whole palette, so a new role cannot be added without a name for it', () => {
  // Guards the other direction: a role appended to the palette and left unnamed here is one the
  // conflict scanner and the preview cannot refer to at all.
  assert.equal(Object.keys(GCODE_FEATURE_ROLES).length, GCODE_FEATURE_NAMES.length)
})
