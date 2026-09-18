import assert from 'node:assert/strict'
import test from 'node:test'
import { replaceMaterialRecipe } from './materialSlotReplacement'
import type { SessionFilamentSlot } from './useMaterialSlots'

const physical = (id: number): SessionFilamentSlot => ({ projectFilamentId: id, sourceIndex: id - 1, label: 'PLA', color: '#FFFFFF', nozzleId: null })
const mixed = (ids: number[]): SessionFilamentSlot => ({ ...physical(4), mixedFilament: {
  componentIds: ids, ratios: ids.map(() => 1 / ids.length), gradient: false, gradientRange: [0, 1], gradientCurve: null, gradientPerPart: false, issues: []
} })

test('replacing one mix input with another combines shares without duplicate components', () => {
  const mix = mixed([1, 2, 3])
  const out = replaceMaterialRecipe(mix, [physical(1), physical(2), physical(3), mix], 1, 2)
  assert.deepEqual(out.mixedFilament?.componentIds, [2, 3])
  assert.deepEqual(out.mixedFilament?.ratios, [2 / 3, 1 / 3])
  assert.deepEqual(mix.mixedFilament?.componentIds, [1, 2, 3])
})

test('a mix reduced to one component becomes that physical material while keeping its slot identity', () => {
  const mix = mixed([1, 2])
  const out = replaceMaterialRecipe(mix, [physical(1), physical(2), mix], 1, 2)
  assert.equal(out.projectFilamentId, 4)
  assert.equal(out.sourceIndex, 1)
  assert.equal(out.mixedFilament, null)
})

test('choosing the affected mix itself as replacement never creates a cyclic recipe', () => {
  const mix = mixed([1, 2])
  const out = replaceMaterialRecipe(mix, [physical(1), physical(2), mix], 1, 4)
  assert.equal(out.mixedFilament, null)
  assert.equal(out.sourceIndex, 1)
})
