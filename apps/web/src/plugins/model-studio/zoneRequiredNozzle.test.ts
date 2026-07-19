import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zoneRequiredNozzle } from './editorGeometry'

// The zone requirement is compared directly against `filament.nozzleId` from the parsed 3MF index,
// so it MUST answer in the same runtime space (0 = right, 1 = left). It used to answer 1 = left /
// 2 = right, and since a nozzle id is only ever 0 or 1, every `has(2)` comparison was dead: right
// nozzle objects were never held out of a left-nozzle-only zone when arranging, and a right-nozzle
// object sitting legitimately in the "Right nozzle only area" was flagged as unreachable.
test('zone requirements use runtime nozzle ids, matching filament.nozzleId', () => {
  assert.equal(zoneRequiredNozzle('Left nozzle only area'), 1)
  assert.equal(zoneRequiredNozzle('Right nozzle only area'), 0)
})

test('an unlabelled or plain unprintable zone requires no particular nozzle', () => {
  assert.equal(zoneRequiredNozzle(null), null)
  assert.equal(zoneRequiredNozzle(''), null)
  assert.equal(zoneRequiredNozzle('Unprintable area'), null)
})
