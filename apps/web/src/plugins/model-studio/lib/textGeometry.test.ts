/**
 * The Text tool's geometry, tested against the real subsetted font files it ships with.
 *
 * The assertion that matters most is HOLES. A glyph is several closed contours and the inner ones
 * are counters; extrude them all as solids and the text still looks correct in outline while
 * printing as filled blobs. That failure is invisible in a triangle count, so the shapes are
 * asserted directly.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import opentype, { type Font } from 'opentype.js'
import { buildSurfaceTextSoup, buildTextSoup, glyphAdvances, textShapes } from './textGeometry'

const FONT_DIR = path.resolve(import.meta.dirname, '../../../../public/fonts/text-tool')

async function loadFont(file = 'dejavu-sans.ttf'): Promise<Font> {
  const bytes = await readFile(path.join(FONT_DIR, file))
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

const OPTIONS = { text: 'A', fontSize: 10, thickness: 2, textGap: 0, rotateAngle: 0 }

test('a counter becomes a HOLE, not a second solid', async () => {
  const font = await loadFont()
  // 'o' is one contour with one counter; 'l' has none. If the counter were extruded as a solid the
  // hole count would be 0 here and the printed text would have filled bowls.
  const [o] = textShapes(font, { ...OPTIONS, text: 'o' })
  assert.ok(o, 'no shape produced for o')
  assert.equal(o.holes.length, 1, 'the bowl of an o was not detected as a hole')
  const [l] = textShapes(font, { ...OPTIONS, text: 'l' })
  assert.equal(l?.holes.length, 0, 'an l has no counter but one was invented')
})

test('a two-counter glyph keeps both holes', async () => {
  const font = await loadFont()
  const [eight] = textShapes(font, { ...OPTIONS, text: '8' })
  assert.equal(eight?.holes.length, 2, 'an 8 has two counters')
})

test('thickness sets the extrusion depth and nothing else', async () => {
  const font = await loadFont()
  const zRange = (soup: Float32Array): number => {
    let min = Infinity, max = -Infinity
    for (let i = 2; i < soup.length; i += 3) { min = Math.min(min, soup[i]!); max = Math.max(max, soup[i]!) }
    return max - min
  }
  assert.ok(Math.abs(zRange(buildTextSoup(font, { ...OPTIONS, thickness: 2 })) - 2) < 1e-4)
  assert.ok(Math.abs(zRange(buildTextSoup(font, { ...OPTIONS, thickness: 5 })) - 5) < 1e-4)
})

test('the soup is centred on the origin, because text is placed as a part', async () => {
  const font = await loadFont()
  const soup = buildTextSoup(font, { ...OPTIONS, text: 'Hello' })
  for (const axis of [0, 1, 2]) {
    let min = Infinity, max = -Infinity
    for (let i = axis; i < soup.length; i += 3) { min = Math.min(min, soup[i]!); max = Math.max(max, soup[i]!) }
    assert.ok(Math.abs((min + max) / 2) < 1e-4, `axis ${axis} is not centred`)
  }
})

test('font size scales the result proportionally', async () => {
  const font = await loadFont()
  const width = (size: number): number => {
    const soup = buildTextSoup(font, { ...OPTIONS, text: 'Hello', fontSize: size })
    let min = Infinity, max = -Infinity
    for (let i = 0; i < soup.length; i += 3) { min = Math.min(min, soup[i]!); max = Math.max(max, soup[i]!) }
    return max - min
  }
  assert.ok(Math.abs(width(20) / width(10) - 2) < 0.01, 'doubling the size did not double the width')
})

test('text gap widens the run, and a negative gap tightens it', async () => {
  const font = await loadFont()
  const width = (gap: number): number => {
    const soup = buildTextSoup(font, { ...OPTIONS, text: 'IIII', textGap: gap })
    let min = Infinity, max = -Infinity
    for (let i = 0; i < soup.length; i += 3) { min = Math.min(min, soup[i]!); max = Math.max(max, soup[i]!) }
    return max - min
  }
  const base = width(0)
  // Three gaps between four glyphs.
  assert.ok(Math.abs(width(1) - (base + 3)) < 0.01, 'a 1mm gap did not add 3mm across four glyphs')
  assert.ok(width(-0.5) < base, 'a negative gap did not tighten the run')
})

test('glyphs advance along +X in order, one shape group each', async () => {
  const font = await loadFont()
  const shapes = textShapes(font, { ...OPTIONS, text: 'AV' })
  assert.equal(shapes.length, 2, 'each glyph should contribute one solid contour here')
  const midX = (shape: (typeof shapes)[number]): number => {
    const points = shape.getPoints(8)
    return points.reduce((sum, p) => sum + p.x, 0) / points.length
  }
  assert.ok(midX(shapes[0]!) < midX(shapes[1]!), 'glyphs were not laid out left to right')
})

test('text with no outlines yields nothing rather than an empty part', async () => {
  const font = await loadFont()
  assert.equal(buildTextSoup(font, { ...OPTIONS, text: '   ' }).length, 0)
  assert.equal(buildTextSoup(font, { ...OPTIONS, text: '' }).length, 0)
})

test('every bundled face loads and produces geometry', async () => {
  for (const file of ['dejavu-sans.ttf', 'dejavu-sans-bold.ttf', 'dejavu-serif.ttf',
    'dejavu-serif-bold.ttf', 'dejavu-mono.ttf', 'dejavu-mono-bold.ttf']) {
    const font = await loadFont(file)
    const soup = buildTextSoup(font, { ...OPTIONS, text: 'Ag8' })
    assert.ok(soup.length > 0 && soup.length % 9 === 0, `${file} produced no usable soup`)
  }
})

test('surface text seats each glyph on its own frame, not on one plane', async () => {
  // The whole point of the surface modes: a run that follows curvature cannot be one flat mesh,
  // because a flat mesh is only ever tangent at a single point.
  const font = await loadFont()
  const options = { ...OPTIONS, text: 'III', thickness: 1 }
  const frames = [
    { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, tangent: { x: 1, y: 0, z: 0 } },
    { position: { x: 20, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, tangent: { x: 0, y: 1, z: 0 } },
    { position: { x: 0, y: 20, z: 0 }, normal: { x: 0, y: 1, z: 0 }, tangent: { x: 0, y: 0, z: 1 } }
  ]
  const soup = buildSurfaceTextSoup(font, options, frames)
  assert.ok(soup.length > 0 && soup.length % 9 === 0)

  // Each glyph should cluster around its own frame position, which a single flat run cannot do.
  const near = (px: number, py: number, pz: number): number => {
    let count = 0
    for (let i = 0; i < soup.length; i += 3) {
      if (Math.hypot(soup[i]! - px, soup[i + 1]! - py, soup[i + 2]! - pz) < 12) count += 1
    }
    return count
  }
  assert.ok(near(0, 0, 0) > 0, 'nothing near the first frame')
  assert.ok(near(20, 0, 0) > 0, 'nothing near the second frame')
  assert.ok(near(0, 20, 0) > 0, 'nothing near the third frame')
})

test('a null frame skips its glyph rather than stacking it', async () => {
  const font = await loadFont()
  const options = { ...OPTIONS, text: 'II' }
  const frame = { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, tangent: { x: 1, y: 0, z: 0 } }
  const both = buildSurfaceTextSoup(font, options, [frame, { ...frame, position: { x: 20, y: 0, z: 0 } }])
  const one = buildSurfaceTextSoup(font, options, [frame, null])
  assert.ok(one.length > 0 && one.length < both.length, 'the dropped glyph was still emitted')
})

test('glyph advances match the flat layout, so spacing does not change with the mode', async () => {
  const font = await loadFont()
  const advances = glyphAdvances(font, { ...OPTIONS, text: 'ABC', textGap: 2 })
  assert.equal(advances.length, 3)
  // Each advance carries the gap, so the run's total matches what flat layout would produce.
  const noGap = glyphAdvances(font, { ...OPTIONS, text: 'ABC', textGap: 0 })
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(advances[i]! - noGap[i]! - 2) < 1e-6)
})

test('letters of different heights share ONE baseline, not their own centres', async () => {
  const font = await loadFont()
  // A tall cap, an x-height letter and a descender. Centring each glyph on its own bounding box
  // aligns their CENTRES, which pushes the short letter up and drops the tall one -- the run then
  // reads as though every letter were top-aligned. Flat text never showed it, because the whole run
  // is one geometry sharing one baseline.
  const options = { text: 'Tep', fontSize: 10, thickness: 2, textGap: 0, rotateAngle: 0 }
  const flat = { normal: { x: 0, y: 0, z: 1 }, tangent: { x: 1, y: 0, z: 0 } }
  const frames = [
    { ...flat, position: { x: 0, y: 0, z: 0 } },
    { ...flat, position: { x: 10, y: 0, z: 0 } },
    { ...flat, position: { x: 20, y: 0, z: 0 } }
  ]
  const soup = buildSurfaceTextSoup(font, options, frames)
  assert.ok(soup.length > 0, 'nothing was built')

  // Each glyph occupies its own 10mm-wide slot along x; compare their vertical extents.
  const slots = frames.map((frame) => ({ centre: frame.position.x, min: Infinity, max: -Infinity }))
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i]!
    const y = soup[i + 1]!
    const slot = slots.reduce((best, entry) =>
      Math.abs(x - entry.centre) < Math.abs(x - best.centre) ? entry : best)
    slot.min = Math.min(slot.min, y)
    slot.max = Math.max(slot.max, y)
  }
  const [capital, xHeight, descender] = slots

  // A capital T reaches higher than a lowercase e...
  assert.ok(capital!.max > xHeight!.max + 0.5,
    `T (${capital!.max}) should rise above e (${xHeight!.max})`)
  // ...and a p drops below both, which per-glyph centring destroys by lifting it to match.
  assert.ok(descender!.min < xHeight!.min - 0.5,
    `p (${descender!.min}) should descend below e (${xHeight!.min})`)
  // The giveaway for centre-alignment: every glyph's midpoint would coincide.
  const midpoints = slots.map((slot) => (slot.min + slot.max) / 2)
  const spread = Math.max(...midpoints) - Math.min(...midpoints)
  assert.ok(spread > 0.3, `glyph midpoints coincide (spread ${spread}), so they are centre-aligned`)
})

test('surface advances kern exactly as the flat layout does', async () => {
  const font = await loadFont()
  // A pair the font kerns. The run's total advance must match the flat layout's pen travel, or the
  // same word spaces differently between Flat and the Follow modes and reads as another font.
  const options = { text: 'AVATAR', fontSize: 10, thickness: 2, textGap: 0, rotateAngle: 0 }
  const advances = glyphAdvances(font, options)
  const scale = options.fontSize / font.unitsPerEm

  // The flat pen: advanceWidth plus the kerning applied BEFORE each glyph, exactly as textShapes.
  let pen = 0
  let previous: number | null = null
  for (const character of options.text) {
    const glyph = font.charToGlyph(character)
    if (!glyph) continue
    if (previous != null) pen += (font.getKerningValue(previous, glyph.index) || 0) * scale
    pen += (glyph.advanceWidth ?? 0) * scale
    previous = glyph.index
  }
  const total = advances.reduce((sum, advance) => sum + advance, 0)
  assert.ok(Math.abs(total - pen) < 1e-6, `surface run is ${total}mm against the flat pen's ${pen}mm`)

  // NOTE this fixture cannot demonstrate kerning itself: the bundled faces are subsets built by
  // scripts/dev/generate-text-tool-fonts.mjs and carry no legacy `kern` table, and opentype 2.x does
  // not read GPOS. So the guarantee here is STRUCTURAL -- both paths compute the same term from the
  // same source -- and it matters for the fonts users load, which do carry one.
  const a = font.charToGlyph('A')
  const v = font.charToGlyph('V')
  const kerned = a && v ? font.getKerningValue(a.index, v.index) : 0
  assert.equal(kerned, 0, 'a bundled face gained a kern table; this test can now discriminate')
})
