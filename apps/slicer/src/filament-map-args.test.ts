import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFilamentMapArgs } from './filament-map-args.js'

// The separator is load-bearing, not cosmetic: BambuStudio parses `--filament-map` as a
// ConfigOptionInts, which splits on COMMAS only. Passing the space- or semicolon-joined form
// (the shape the 3MF's per-plate `filament_maps` metadata uses) parses to a ONE-entry vector,
// and the manual-mode check then reads `filament_maps[i]` out of bounds — the slice aborts with
// "filament Sup.PLA can not be printed on extruder 21840". Verified against 2.7.1.62.
test('buildFilamentMapArgs joins the assignment with commas, one entry per filament', () => {
  assert.deepEqual(buildFilamentMapArgs(['1', '2']), ['--filament-map', '1,2'])
  assert.deepEqual(buildFilamentMapArgs(['2', '1', '1']), ['--filament-map', '2,1,1'])
})

test('buildFilamentMapArgs emits nothing when there is no manual assignment', () => {
  assert.deepEqual(buildFilamentMapArgs(null), [], 'no flag leaves the CLI in its automatic mode')
  assert.deepEqual(buildFilamentMapArgs([]), [], 'an empty map would pin nothing and hide the mismatch')
})
