import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectRemoteImportUrl,
  parseMakerWorldModelUrl,
  rankRemoteImportCandidates,
  recommendRemoteImportCandidate,
  remoteImportCandidateSchema,
  sanitizeRemoteImportThumbnailUrl
} from './remote-imports.js'

test('detectRemoteImportUrl treats direct printable files as server-download imports', () => {
  const resolution = detectRemoteImportUrl('https://downloads.example.com/parts/widget.gcode.3mf')

  assert.equal(resolution.provider, 'generic')
  assert.equal(resolution.kind, 'direct-file')
  assert.equal(resolution.strategy, 'server-download')
  assert.equal(resolution.directFileKind, 'gcode')
  assert.equal(resolution.suggestedFileName, 'widget.gcode.3mf')
})

test('detectRemoteImportUrl classifies MakerWorld model pages as browser-assist imports', () => {
  const resolution = detectRemoteImportUrl('https://makerworld.com/en/models/578636-the-best-sword-in-the-world#profileId-499360')

  assert.equal(resolution.provider, 'makerworld')
  assert.equal(resolution.kind, 'provider-model-page')
  assert.equal(resolution.strategy, 'browser-assist')
})

test('detectRemoteImportUrl classifies Printables model pages as browser-assist imports', () => {
  const resolution = detectRemoteImportUrl('https://www.printables.com/model/1078334-pikachu-low-poly')

  assert.equal(resolution.provider, 'printables')
  assert.equal(resolution.kind, 'provider-model-page')
  assert.equal(resolution.strategy, 'browser-assist')
})

test('detectRemoteImportUrl classifies locale-prefixed Printables model pages as browser-assist imports', () => {
  const resolution = detectRemoteImportUrl('https://www.printables.com/de/model/1078334-pikachu-low-poly')

  assert.equal(resolution.provider, 'printables')
  assert.equal(resolution.kind, 'provider-model-page')
  assert.equal(resolution.strategy, 'browser-assist')
})

test('detectRemoteImportUrl leaves non-model Printables pages unsupported', () => {
  const resolution = detectRemoteImportUrl('https://www.printables.com/search/models')

  assert.equal(resolution.provider, 'printables')
  assert.equal(resolution.kind, 'web-page')
  assert.equal(resolution.strategy, 'unsupported')
})

test('detectRemoteImportUrl keeps future providers as unsupported generic web pages', () => {
  const resolution = detectRemoteImportUrl('https://future-models.example/models/123')

  assert.equal(resolution.provider, 'generic')
  assert.equal(resolution.kind, 'web-page')
  assert.equal(resolution.strategy, 'unsupported')
})

test('detectRemoteImportUrl leaves generic web pages unsupported', () => {
  const resolution = detectRemoteImportUrl('https://example.com/blog/post-about-printing')

  assert.equal(resolution.provider, 'generic')
  assert.equal(resolution.kind, 'web-page')
  assert.equal(resolution.strategy, 'unsupported')
})

test('rankRemoteImportCandidates recommends sliced files before model-only files', () => {
  const ranked = rankRemoteImportCandidates([
    {
      id: 'stl',
      provider: 'printables',
      sourceUrl: 'https://files.printables.com/model.stl',
      name: 'model.stl',
      sizeBytes: 1000,
      fileType: 'stl',
      printableStatus: 'needs-slicing',
      confidence: 0.95,
      recommendationReason: 'Model mesh needs slicing before printing.',
      thumbnailUrl: null
    },
    {
      id: 'plain-3mf',
      provider: 'printables',
      sourceUrl: 'https://files.printables.com/model.3mf',
      name: 'model.3mf',
      sizeBytes: 2000,
      fileType: '3mf',
      printableStatus: 'unknown',
      confidence: 0.95,
      recommendationReason: '3MF may need slicing unless verified as printer-ready.',
      thumbnailUrl: null
    },
    {
      id: 'gcode',
      provider: 'printables',
      sourceUrl: 'https://files.printables.com/model.gcode',
      name: 'model.gcode',
      sizeBytes: 3000,
      fileType: 'gcode',
      printableStatus: 'printer-ready',
      confidence: 0.9,
      recommendationReason: 'G-code can be sent directly to a printer.',
      thumbnailUrl: null
    },
    {
      id: 'gcode-3mf',
      provider: 'printables',
      sourceUrl: 'https://files.printables.com/model.gcode.3mf',
      name: 'model.gcode.3mf',
      sizeBytes: 4000,
      fileType: 'gcode',
      printableStatus: 'printer-ready',
      confidence: 0.8,
      recommendationReason: 'Bambu sliced 3MF can be sent directly to a printer.',
      thumbnailUrl: null
    }
  ])

  assert.deepEqual(ranked.map((candidate) => candidate.id), ['gcode-3mf', 'gcode', 'plain-3mf', 'stl'])
  assert.equal(recommendRemoteImportCandidate(ranked)?.id, 'gcode-3mf')
})

test('recommendRemoteImportCandidate falls back to STL when only model files are available', () => {
  const recommended = recommendRemoteImportCandidate([
    {
      id: 'only-stl',
      provider: 'printables',
      sourceUrl: 'https://files.printables.com/model.stl',
      name: 'model.stl',
      sizeBytes: null,
      fileType: 'stl',
      printableStatus: 'needs-slicing',
      confidence: 0.9,
      recommendationReason: 'Mesh files import to the library and require slicing before printing.',
      thumbnailUrl: null
    }
  ])

  assert.equal(recommended?.id, 'only-stl')
  assert.equal(recommended?.printableStatus, 'needs-slicing')
})

test('sanitizeRemoteImportThumbnailUrl accepts provider https hosts and rejects everything else', () => {
  assert.equal(
    sanitizeRemoteImportThumbnailUrl('https://makerworld.bblmw.com/cover.png'),
    'https://makerworld.bblmw.com/cover.png'
  )
  assert.equal(
    sanitizeRemoteImportThumbnailUrl('https://media.printables.com/cover.png'),
    'https://media.printables.com/cover.png'
  )
  for (const rejected of [
    'http://makerworld.bblmw.com/cover.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'https://evil.example.com/cover.png',
    'https://evil-bblmw.com/cover.png',
    'not a url',
    '',
    null
  ]) {
    assert.equal(sanitizeRemoteImportThumbnailUrl(rejected), null, `should reject ${String(rejected)}`)
  }
})

test('remoteImportCandidateSchema defaults and sanitizes the thumbnail', () => {
  const base = {
    id: 'candidate',
    provider: 'makerworld',
    sourceUrl: 'https://makerworld.com/en/models/1#profileId-2',
    name: 'model.3mf',
    sizeBytes: null,
    fileType: '3mf',
    printableStatus: 'unknown',
    confidence: 0.9,
    recommendationReason: 'Import to the library.'
  }

  // Candidates minted by extension builds that predate the field must still parse.
  assert.equal(remoteImportCandidateSchema.parse(base).thumbnailUrl, null)
  assert.equal(remoteImportCandidateSchema.parse({ ...base, thumbnailUrl: 'javascript:alert(1)' }).thumbnailUrl, null)
  assert.equal(
    remoteImportCandidateSchema.parse({ ...base, thumbnailUrl: 'https://public-cdn.bblmw.com/a.png' }).thumbnailUrl,
    'https://public-cdn.bblmw.com/a.png'
  )
})

test('parseMakerWorldModelUrl reads the design id from slugged and bare model paths', () => {
  assert.deepEqual(
    parseMakerWorldModelUrl('https://makerworld.com/en/models/578636-the-best-sword-in-the-world'),
    { designId: 578636, instanceId: null }
  )
  assert.deepEqual(
    parseMakerWorldModelUrl('https://makerworld.com/models/578636'),
    { designId: 578636, instanceId: null }
  )
  assert.deepEqual(
    parseMakerWorldModelUrl('https://makerworld.com/de/models/1234-etwas?ref=x'),
    { designId: 1234, instanceId: null }
  )
})

// The profile rides in the fragment, which never reaches a server by itself, this is
// why the parse has to run where the user's whole pasted string is still intact.
test('parseMakerWorldModelUrl reads the profile id out of the fragment', () => {
  assert.deepEqual(
    parseMakerWorldModelUrl('https://makerworld.com/en/models/578636-slug#profileId-499360'),
    { designId: 578636, instanceId: 499360 }
  )
})

test('parseMakerWorldModelUrl rejects non-MakerWorld and non-model URLs', () => {
  assert.equal(parseMakerWorldModelUrl('https://www.printables.com/model/12345-thing'), null)
  assert.equal(parseMakerWorldModelUrl('https://evil-makerworld.com/models/1'), null)
  assert.equal(parseMakerWorldModelUrl('https://makerworld.com/en/search?q=sword'), null)
  assert.equal(parseMakerWorldModelUrl('not a url'), null)
})

test('parseMakerWorldModelUrl ignores a malformed profile fragment rather than guessing', () => {
  assert.deepEqual(
    parseMakerWorldModelUrl('https://makerworld.com/en/models/578636-slug#profileId-abc'),
    { designId: 578636, instanceId: null }
  )
})
