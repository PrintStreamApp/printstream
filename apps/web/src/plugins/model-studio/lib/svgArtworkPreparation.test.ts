import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../../../test-utils/jsdom'

let dom: JSDOM
let parseSvgShapes: typeof import('./svgGeometry').parseSvgShapes
let prepareSvgArtwork: typeof import('./svgArtworkPreparation').prepareSvgArtwork

before(async () => {
  dom = installJsdomGlobals()
  Object.assign(globalThis, { DOMParser: dom.window.DOMParser })
  parseSvgShapes = (await import('./svgGeometry')).parseSvgShapes
  prepareSvgArtwork = (await import('./svgArtworkPreparation')).prepareSvgArtwork
})

after(() => dom.window.close())

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="100" height="100" fill="#fff"/>
  <path d="M 10 10 H 40 V 40 H 10 Z" fill="black"/>
  <path d="M 60 60 H 90 V 90 H 60 Z" fill="black"/>
</svg>`

function prepare(markup: string, options: {
  includeBackground?: boolean
  archiveEntries?: string[]
  reedit?: { entryPath: string; loadedMarkup: string } | null
} = {}) {
  return prepareSvgArtwork({
    artwork: parseSvgShapes(markup),
    settings: { widthMm: 100, thickness: 2, includeBackground: options.includeBackground ?? false },
    fileName: 'logo.svg',
    markup,
    state: null,
    archiveEntries: options.archiveEntries ?? [],
    reedit: options.reedit ?? null
  })
}

test('dropping a backdrop preserves source piece numbers and never claims the whole SVG', () => {
  const prepared = prepare(LOGO)
  assert.ok(prepared)
  assert.equal(prepared.split, true)
  assert.deepEqual(prepared.soups.map((piece) => piece.index), [2, 3])
  assert.equal(prepared.partName(2), 'logo 2')
  assert.equal(prepared.recordFor(2)?.pieceIndex, 2)
  assert.equal(prepared.bambuShapeFor(), null)
  assert.equal(prepared.markupToStore, LOGO)
})

test('a whole single-piece drawing carries the Studio record and a merged part identity', () => {
  const markup = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 H 10 V 10 H 0 Z" fill="black"/></svg>'
  const prepared = prepare(markup)
  assert.ok(prepared)
  assert.equal(prepared.split, false)
  assert.equal(prepared.soups.length, 1)
  assert.equal(prepared.recordFor(1)?.pieceIndex, 0)
  assert.equal(prepared.partName(1), 'logo')
  assert.equal(prepared.bambuShapeFor()?.depth, 2)
  assert.equal(prepared.bambuShapeFor()?.filePathIn3mf, prepared.entryPath)
})

test('an unchanged re-edit reuses its archive entry, while a new drawing gets a new one', () => {
  const existing = '3D/logo.svg'
  const reused = prepare(LOGO, {
    archiveEntries: [existing], reedit: { entryPath: existing, loadedMarkup: LOGO }
  })
  assert.ok(reused)
  assert.equal(reused.entryPath, existing)
  assert.equal(reused.markupToStore, null)

  const changed = prepare(`${LOGO}\n`, {
    archiveEntries: [existing], reedit: { entryPath: existing, loadedMarkup: LOGO }
  })
  assert.ok(changed)
  assert.notEqual(changed.entryPath, existing)
  assert.equal(changed.markupToStore, `${LOGO}\n`)
})

test('an illustration above the part cap merges only surviving shapes', () => {
  const marks = Array.from({ length: 25 }, (_, index) => (
    `<rect x="${index * 3}" y="10" width="2" height="2" fill="black"/>`
  )).join('')
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect x="0" y="0" width="100" height="100" fill="#fff"/>${marks}</svg>`
  const withoutBackdrop = prepare(markup)
  const withBackdrop = prepare(markup, { includeBackground: true })
  assert.ok(withoutBackdrop)
  assert.ok(withBackdrop)
  assert.equal(withoutBackdrop.split, false)
  assert.equal(withoutBackdrop.soups.length, 1)
  assert.equal(withoutBackdrop.recordFor(1)?.pieceIndex, 0)
  assert.equal(withoutBackdrop.bambuShapeFor(), null)
  assert.ok(withoutBackdrop.soups[0]!.soup.length < withBackdrop.soups[0]!.soup.length)
  assert.ok(withBackdrop.bambuShapeFor())
})
