import assert from 'node:assert/strict'
import { test } from 'node:test'
import { colorDistance } from './colorDistance'
import { suggestTagColor } from './tagColors'

test('successive defaults stay unique and perceptually separated for a small catalog', () => {
  const colors: string[] = []
  for (let index = 0; index < 12; index++) {
    const color = suggestTagColor(colors)
    assert.match(color, /^#[0-9a-f]{6}$/)
    assert.ok(!colors.includes(color))
    for (const previous of colors) assert.ok(colorDistance(color, previous) > 15)
    colors.push(color)
  }
})

test('custom colors are considered case-insensitively without changing existing choices', () => {
  const colors = ['#38BDF8', '#123456']
  assert.ok(!colors.map((color) => color.toLowerCase()).includes(suggestTagColor(colors)))
  assert.deepEqual(colors, ['#38BDF8', '#123456'])
})
