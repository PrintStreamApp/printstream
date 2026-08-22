import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRemoteImportCandidate, detectRemoteImportUrl } from '@printstream/shared'
import { selectPickerCandidates } from './candidateSelection'

const handoffCandidates = [
  buildRemoteImportCandidate({
    provider: 'makerworld',
    sourceUrl: 'https://public-cdn.bblmw.com/scraped.gcode.3mf',
    name: 'scraped.gcode.3mf',
    sizeBytes: null,
    confidence: 1
  })
]
const handoffUrl = 'https://makerworld.com/en/models/1-old'

test('selectPickerCandidates keeps the handoff files while the field still holds the scraped page', () => {
  const result = selectPickerCandidates({
    handoffCandidates,
    handoffUrl,
    url: handoffUrl,
    pastedCandidates: detectRemoteImportUrl(handoffUrl).candidates,
    importCandidates: []
  })

  assert.equal(result.staleHandoff, false)
  assert.deepEqual(result.candidates, handoffCandidates)
})

test('selectPickerCandidates keeps the handoff files for a new page that needs the browser helper', () => {
  const url = 'https://www.printables.com/model/1078334-pikachu'
  const result = selectPickerCandidates({
    handoffCandidates,
    handoffUrl,
    url,
    pastedCandidates: detectRemoteImportUrl(url).candidates,
    importCandidates: []
  })

  assert.equal(result.staleHandoff, true)
  assert.deepEqual(result.candidates, handoffCandidates)
})

test('selectPickerCandidates swaps in a pasted direct file URL immediately', () => {
  const url = 'https://downloads.example.com/widget.gcode.3mf'
  const result = selectPickerCandidates({
    handoffCandidates,
    handoffUrl,
    url,
    pastedCandidates: detectRemoteImportUrl(url).candidates,
    importCandidates: []
  })

  assert.equal(result.staleHandoff, true)
  assert.deepEqual(result.candidates.map((candidate) => candidate.name), ['widget.gcode.3mf'])
})

test('selectPickerCandidates falls back to the import URL candidates with no handoff', () => {
  const url = 'https://downloads.example.com/widget.gcode.3mf'
  const importCandidates = detectRemoteImportUrl(url).candidates
  const result = selectPickerCandidates({
    handoffCandidates: [],
    handoffUrl: '',
    url,
    pastedCandidates: importCandidates,
    importCandidates
  })

  assert.equal(result.staleHandoff, false)
  assert.deepEqual(result.candidates, importCandidates)
})
