/**
 * The generator marker is a WHOLE-FILE gate, not a nicety: without it the importer forces
 * `dont_load_config` (`bbs_3mf.cpp:1905-1908`) and skips every config entry, so the project opens as
 * bare geometry with its settings, plates and per-object bindings silently gone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureApplicationMarker, hasApplicationMarker, THREE_MF_APPLICATION_MARKER } from './application-marker.js'

const model = (inner = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter">\n${inner}  <resources/>\n  <build/>\n</model>`

test('a model already marked is returned untouched', () => {
  const marked = model(`  <metadata name="Application">${THREE_MF_APPLICATION_MARKER}</metadata>\n`)
  assert.equal(ensureApplicationMarker(marked), marked)
})

test('an older BambuStudio version still counts, so it is left alone', () => {
  // The importer prefix-matches and parses the rest as a Semver; rewriting a genuine older version
  // would misreport which build actually wrote the file.
  const marked = model('  <metadata name="Application">BambuStudio-01.09.00.00</metadata>\n')
  assert.equal(ensureApplicationMarker(marked), marked)
})

test('a model with no marker gets one, inside the model element', () => {
  const out = ensureApplicationMarker(model())
  assert.ok(hasApplicationMarker(out))
  assert.match(out, /<model\b[^>]*>\s*<metadata name="Application">BambuStudio-/)
})

test('a foreign generator is replaced, not kept', () => {
  // To the importer a value that does not start with BambuStudio- is exactly as absent as no
  // element at all, so leaving it would keep the look of provenance and lose every setting.
  const foreign = model('  <metadata name="Application">PrusaSlicer-2.8.0</metadata>\n')
  const out = ensureApplicationMarker(foreign)
  assert.ok(hasApplicationMarker(out))
  assert.doesNotMatch(out, /PrusaSlicer/)
})

test('the marker parses the way the importer requires', () => {
  // `boost::starts_with(value, "BambuStudio-")` then `Semver::parse(value.substr(12))`.
  assert.ok(THREE_MF_APPLICATION_MARKER.startsWith('BambuStudio-'))
  assert.match(THREE_MF_APPLICATION_MARKER.slice(12), /^\d+\.\d+\.\d+(\.\d+)?$/)
})

test('a model with no recognisable open tag is left alone rather than corrupted', () => {
  assert.equal(ensureApplicationMarker('not xml at all'), 'not xml at all')
})
