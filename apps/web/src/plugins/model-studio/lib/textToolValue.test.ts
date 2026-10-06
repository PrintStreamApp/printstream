import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultTextInfo } from '@printstream/shared/three-mf'
import { BUNDLED_FONTS } from './textFonts'
import { textToolValueFromInfo, type TextToolValue } from './textToolValue'

test('saved text remains editable when its font is unavailable', () => {
  const fallback: TextToolValue = {
    text: 'Fallback', family: BUNDLED_FONTS[0]!.family, bold: false, italic: false,
    fontSize: 12, thickness: 1, textGap: 0, rotateAngle: 0, embeddedDepth: 0,
    surfaceMode: 'horizontal', operation: 'normal_part'
  }
  const saved = {
    ...defaultTextInfo('Saved', 'Unavailable Font'),
    surfaceType: 'surfaceChar' as const
  }

  const loaded = textToolValueFromInfo(saved, 'negative_part', fallback)
  assert.equal(loaded.text, 'Saved')
  assert.equal(loaded.family, fallback.family)
  assert.equal(loaded.surfaceMode, 'surface')
  assert.equal(loaded.operation, 'negative_part')
})
