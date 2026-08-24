/**
 * Every paint channel must be covered by the loops that rebuild overlays.
 *
 * This is a source scan because the failure is invisible at runtime and to the type checker: a
 * hardcoded `['supports', 'seam', 'color']` is a perfectly valid array, it just misses a channel.
 * That shipped. Adding fuzzy skin left two such loops behind, so an undo mid-paint rebuilt three
 * channels and silently dropped the fourth, and the next dab (which rebuilds a whole channel from
 * state) made it reappear. No error, no failing test, just paint blinking out.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import { PAINT_CHANNEL_SPECS, TRIANGLE_PAINT_CHANNELS } from './editorGeometry'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Files that rebuild overlays per channel and so must not enumerate channels by hand. */
const OVERLAY_REBUILDERS = ['useEditorPaint.ts', 'EditorView.tsx']

test('the derived channel list covers exactly the spec map', () => {
  assert.deepEqual([...TRIANGLE_PAINT_CHANNELS].sort(), Object.keys(PAINT_CHANNEL_SPECS).sort())
  assert.ok(TRIANGLE_PAINT_CHANNELS.includes('fuzzy'), 'fuzzy skin is missing from the channel list')
})

test('no overlay rebuilder enumerates paint channels by hand', () => {
  // Matches an array literal of quoted channel names, which is what the two broken loops were.
  const handWritten = /\[\s*'(?:supports|seam|color|fuzzy)'\s*,\s*'(?:supports|seam|color|fuzzy)'/
  for (const file of OVERLAY_REBUILDERS) {
    const source = readFileSync(path.join(here, file), 'utf8')
    assert.equal(
      handWritten.test(source),
      false,
      `${file} lists paint channels inline; use TRIANGLE_PAINT_CHANNELS so a new channel cannot be missed`
    )
  }
})
