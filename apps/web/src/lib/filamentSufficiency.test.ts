import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filamentRemainingStatus, formatFilamentRemaining } from './filamentSufficiency.js'

test('formatFilamentRemaining renders the shared "percent (~grams)" estimate badge for every surface', () => {
  // Percent leads (rounded); the estimated weight follows in brackets with a "~". Every print dialog
  // slot picker and material picker shares this exact form.
  assert.equal(formatFilamentRemaining(480, 48), '48% (~480g)')
  // Fractional percent rounds.
  assert.equal(formatFilamentRemaining(480, 47.6), '48% (~480g)')
  // No percent: just the bracket-free estimated weight.
  assert.equal(formatFilamentRemaining(480), '~480g')
  assert.equal(formatFilamentRemaining(480, null), '~480g')
  // Aggregated across spools adds the "total" suffix inside the brackets.
  assert.equal(formatFilamentRemaining(690, 69, true), '69% (~690g total)')
  assert.equal(formatFilamentRemaining(690, null, true), '~690g total')
})

test('filamentRemainingStatus is null when the remaining amount is unknown', () => {
  assert.equal(filamentRemainingStatus(null, 100), null)
  assert.equal(filamentRemainingStatus(undefined, 100), null)
})

test('filamentRemainingStatus just states the amount when nothing is required', () => {
  assert.deepEqual(filamentRemainingStatus(480, null), { text: '~480g left', tone: 'text.tertiary' })
  assert.deepEqual(filamentRemainingStatus(480, undefined), { text: '~480g left', tone: 'text.tertiary' })
})

test('filamentRemainingStatus reads "enough" with comfortable headroom', () => {
  // 200 needed, 480 on hand — well above the 25g headroom.
  assert.deepEqual(filamentRemainingStatus(480, 200), { text: '~480g left', tone: 'text.tertiary' })
  // Exactly at the headroom boundary (required + 25) still reads as enough.
  assert.deepEqual(filamentRemainingStatus(125, 100), { text: '~125g left', tone: 'text.tertiary' })
})

test('filamentRemainingStatus warns "low" when sufficient but within the thin margin', () => {
  // Has enough (>= required) but less than required + 25g headroom.
  assert.deepEqual(filamentRemainingStatus(110, 100), { text: '~110g · low', tone: 'warning.plainColor' })
  // Exactly the required amount is still enough-but-low (not short).
  assert.deepEqual(filamentRemainingStatus(100, 100), { text: '~100g · low', tone: 'warning.plainColor' })
})

test('filamentRemainingStatus flags "short" with the deficit when below required', () => {
  assert.deepEqual(filamentRemainingStatus(70, 100), { text: '~70g · 30g short', tone: 'danger.plainColor' })
  // Deficit rounds and never shows 0g short for a sub-gram gap.
  assert.deepEqual(filamentRemainingStatus(99, 99.4), { text: '~99g · 1g short', tone: 'danger.plainColor' })
})

test('filamentRemainingStatus adds a "total" suffix for a multi-spool aggregate', () => {
  // Aggregated, no percent: "total" replaces the "left" word.
  assert.deepEqual(filamentRemainingStatus(690, null, null, true), { text: '~690g total', tone: 'text.tertiary' })
  // Aggregated with percent — the "total" rides inside the estimate brackets.
  assert.deepEqual(filamentRemainingStatus(690, 200, 69, true), { text: '69% (~690g total)', tone: 'text.tertiary' })
  // Aggregated keeps the sufficiency qualifier after the brackets.
  assert.deepEqual(filamentRemainingStatus(70, 100, 7, true), { text: '7% (~70g total) · 30g short', tone: 'danger.plainColor' })
  // A single spool (default) keeps "left", not "total".
  assert.deepEqual(filamentRemainingStatus(690, null, null, false), { text: '~690g left', tone: 'text.tertiary' })
})

test('filamentRemainingStatus leads with the percent and brackets the estimated weight, like the slot badge', () => {
  // Enough: "P% (~Gg)" (no "left" word once the percent is shown).
  assert.deepEqual(filamentRemainingStatus(480, 200, 48), { text: '48% (~480g)', tone: 'text.tertiary' })
  // No requirement, percent known.
  assert.deepEqual(filamentRemainingStatus(480, null, 48), { text: '48% (~480g)', tone: 'text.tertiary' })
  // Low and short keep the percent lead plus the qualifier after the brackets.
  assert.deepEqual(filamentRemainingStatus(110, 100, 11), { text: '11% (~110g) · low', tone: 'warning.plainColor' })
  assert.deepEqual(filamentRemainingStatus(70, 100, 7), { text: '7% (~70g) · 30g short', tone: 'danger.plainColor' })
})
