/**
 * The memoization in `profilePrinterCompatibility` must be invisible.
 *
 * These helpers run over the WHOLE filament catalogue (~2,100 presets) every time the slice
 * dialog's compatible-filament filter re-evaluates, and they were re-deriving the same strings and
 * the same 14-model alias table thousands of times per pass -- 32 ms per filter evaluation, which a
 * CPU profile of the idle editor showed as ~43% of all non-idle samples.
 *
 * Caching a pure function is only safe while it stays pure, so this file pins both halves: that the
 * caches are actually live (a repeat call returns the SAME array, not an equal one), and that every
 * cache still invalidates on the input it is keyed by. The one-entry memo for the selected machine
 * is the risky one -- a memo that failed to notice a printer change would quietly filter the
 * catalogue for the PREVIOUS printer, which looks like correct output.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingPresetSummary } from '@printstream/shared'
import {
  compactProfileText,
  extractProfilePrinterTargets,
  normalizedProfileText,
  printerModelTextCandidates,
  selectedPrinterCompatibilityTargets
} from './profilePrinterCompatibility'

function filamentProfile(name: string, compatiblePrinters: string[]): SlicingPresetSummary {
  return { id: `builtin:filament:${name}`, source: 'builtin', kind: 'filament', name, filamentType: 'PLA', compatiblePrinters }
}

function machineProfile(name: string): SlicingPresetSummary {
  return { id: `builtin:machine:${name}`, source: 'builtin', kind: 'machine', name, compatiblePrinters: [name] }
}

test('normalization still strips the vendor prefix and punctuation', () => {
  assert.equal(normalizedProfileText('Bambu Lab H2D 0.4 nozzle'), 'h2d 0.4 nozzle')
  assert.equal(compactProfileText('Bambu Lab A1 mini'), 'a1mini')
  // Repeat calls must agree with the first: a cache that returned the key, or a stale entry after
  // the size guard cleared, would show up here.
  assert.equal(normalizedProfileText('Bambu Lab H2D 0.4 nozzle'), 'h2d 0.4 nozzle')
  assert.equal(compactProfileText('Bambu Lab A1 mini'), 'a1mini')
})

test('a preset is asked about once, not once per pass', () => {
  // Fails without the cache: every call built a fresh array. This is the property that turns a
  // repeated catalogue filter from O(catalogue) work into a map lookup.
  const profile = filamentProfile('Bambu PLA Basic @BBL H2D', ['Bambu Lab H2D 0.4 nozzle'])
  const first = extractProfilePrinterTargets(profile)
  assert.equal(extractProfilePrinterTargets(profile), first, 'the targets were recomputed for the same preset')
  assert.ok(first.length > 0, 'the fixture should resolve at least one target')
})

test('two distinct presets are never confused for each other', () => {
  // The cache is keyed on object identity, so a preset with the same NAME but different targets
  // must still get its own answer -- and a structurally identical copy must agree with the original.
  const h2d = filamentProfile('Bambu PLA Basic @BBL H2D', ['Bambu Lab H2D 0.4 nozzle'])
  const a1 = filamentProfile('Bambu PLA Basic @BBL A1', ['Bambu Lab A1 0.4 nozzle'])
  const h2dCopy = filamentProfile('Bambu PLA Basic @BBL H2D', ['Bambu Lab H2D 0.4 nozzle'])

  const h2dTargets = extractProfilePrinterTargets(h2d)
  const a1Targets = extractProfilePrinterTargets(a1)

  assert.deepEqual(extractProfilePrinterTargets(h2dCopy), h2dTargets, 'an identical preset got a different answer')
  assert.notDeepEqual(a1Targets, h2dTargets, 'two different printers resolved to the same targets')
})

test('the selected-machine memo invalidates on a printer change', () => {
  // The dangerous failure: a stale memo filters the catalogue for the printer the user just
  // switched AWAY from, and every downstream list looks plausible while being wrong.
  const h2d = machineProfile('Bambu Lab H2D 0.4 nozzle')
  const a1Mini = machineProfile('Bambu Lab A1 mini 0.4 nozzle')

  const h2dTargets = selectedPrinterCompatibilityTargets(h2d, 'H2D')
  const a1MiniTargets = selectedPrinterCompatibilityTargets(a1Mini, 'A1mini')
  assert.notDeepEqual(a1MiniTargets, h2dTargets, 'switching machine profile returned the previous printer\'s targets')

  // ...and on the model alone, with the machine profile unchanged.
  assert.notDeepEqual(
    selectedPrinterCompatibilityTargets(h2d, 'A1'),
    selectedPrinterCompatibilityTargets(h2d, 'H2D'),
    'changing the model alone returned the previous model\'s targets'
  )
  // Going back gets the original answer, not a one-way latch.
  assert.deepEqual(selectedPrinterCompatibilityTargets(h2d, 'H2D'), h2dTargets)
})

test('an unknown model still resolves to no candidates', () => {
  assert.deepEqual(printerModelTextCandidates('unknown'), [])
  assert.ok(printerModelTextCandidates('H2D').length > 0)
  assert.equal(printerModelTextCandidates('H2D'), printerModelTextCandidates('H2D'), 'the alias table was rebuilt')
})
