import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownImageLabel, pastedImageFilename, uploadingPlaceholder } from './useSupportImagePaste.js'

test('pastedImageFilename keeps meaningful names and renames generic clipboard ones', () => {
  assert.equal(pastedImageFilename({ name: 'bed-adhesion.png', type: 'image/png' }, 1), 'bed-adhesion.png')
  // Browsers name clipboard screenshots `image.png` (or similar) — rename those.
  assert.equal(pastedImageFilename({ name: 'image.png', type: 'image/png' }, 1), 'pasted-image-1.png')
  assert.equal(pastedImageFilename({ name: 'image.jpeg', type: 'image/jpeg' }, 2), 'pasted-image-2.jpg')
  assert.equal(pastedImageFilename({ name: '', type: 'image/webp' }, 3), 'pasted-image-3.webp')
  // Unknown image subtype falls back to .png rather than no extension.
  assert.equal(pastedImageFilename({ name: '', type: 'image/x-exotic' }, 4), 'pasted-image-4.png')
})

test('markdownImageLabel neutralizes characters that would break the image syntax', () => {
  assert.equal(markdownImageLabel('shot [v2] (final).png'), 'shot _v2_ _final_.png')
  assert.equal(markdownImageLabel('back\\slash.png'), 'back_slash.png')
})

test('uploadingPlaceholder embeds the sanitized label and draft key', () => {
  assert.equal(
    uploadingPlaceholder('a [b].png', 'draft-7'),
    '![a _b_.png](uploading:draft-7)'
  )
})
