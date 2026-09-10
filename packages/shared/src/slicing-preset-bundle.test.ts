/**
 * The bundle we WRITE has to be one our own readers (and BambuStudio's) read back.
 *
 * The pairing is the point: every test that asserts a layout also runs the import side's entry rule
 * over it, because the two halves living in separate modules is exactly how the manifest ended up
 * skipped by one reader and parsed as a preset by the other.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSlicingPresetBundle } from './slicing-preset-bundle.js'
import { isPresetArchivePresetEntry, PRESET_BUNDLE_MANIFEST_NAME } from './slicing-profile-parse.js'

const AT = '20260908T000000'

function preset(kind: 'machine' | 'filament' | 'process', name: string) {
  return { kind, name, content: JSON.stringify({ name, type: kind }) }
}

function manifestOf(files: Array<{ path: string; content: string }>): Record<string, unknown> {
  const entry = files.find((file) => file.path === PRESET_BUNDLE_MANIFEST_NAME)
  assert.ok(entry, 'every bundle carries a manifest')
  return JSON.parse(entry.content) as Record<string, unknown>
}

test('a bundle stores each preset under its kind, with a manifest listing them', () => {
  const { files } = buildSlicingPresetBundle(
    [preset('machine', 'Printer A'), preset('filament', 'Material A'), preset('process', 'Fine')],
    { timestamp: AT }
  )

  assert.deepEqual(files.map((file) => file.path).sort(), [
    'bundle_structure.json',
    'filament/Material A.json',
    'printer/Printer A.json',
    'process/Fine.json'
  ])
  const manifest = manifestOf(files)
  assert.deepEqual(manifest.printer_config, ['printer/Printer A.json'])
  assert.deepEqual(manifest.filament_config, ['filament/Material A.json'])
  assert.deepEqual(manifest.process_config, ['process/Fine.json'])
})

test('the reader takes every preset entry and skips the manifest', () => {
  // The regression that motivated sharing the rule: keeping `bundle_structure.json` made the
  // browser reader try to parse it as a preset and reject the whole archive.
  const { files } = buildSlicingPresetBundle([preset('machine', 'Printer A'), preset('process', 'Fine')], { timestamp: AT })
  const kept = files.filter((file) => isPresetArchivePresetEntry(file.path)).map((file) => file.path)
  assert.deepEqual(kept.sort(), ['printer/Printer A.json', 'process/Fine.json'])
})

test('a filament-only selection is a filament bundle, anything else is a printer bundle', () => {
  // The type decides the extension, as it does in BambuStudio: a filament bundle's manifest has no
  // field that can name a machine or process preset.
  const filaments = buildSlicingPresetBundle([preset('filament', 'PLA Matte')], { timestamp: AT })
  assert.equal(filaments.fileName, 'PLA Matte.bbsflmt')
  assert.equal(manifestOf(filaments.files).bundle_type, 'filament config bundle')
  assert.equal(manifestOf(filaments.files).filament_name, 'PLA Matte')

  const mixed = buildSlicingPresetBundle([preset('filament', 'PLA Matte'), preset('process', 'Fine')], { timestamp: AT })
  assert.equal(mixed.fileName, 'Fine.bbscfg')
  assert.equal(manifestOf(mixed.files).bundle_type, 'printer config bundle')
})

test('a printer bundle is named after its printer, not whichever preset came first', () => {
  const { fileName } = buildSlicingPresetBundle(
    [preset('process', 'Fine'), preset('machine', 'Printer A')],
    { timestamp: AT }
  )
  assert.equal(fileName, 'Printer A.bbscfg')
})

test('presets whose names collide get distinct entries', () => {
  // BambuStudio's importer flattens every entry to its BASE name into one directory, so two
  // presets called "Draft" in different folders would overwrite each other there rather than in
  // the archive. Deduplication is across the whole bundle for that reason.
  const { files } = buildSlicingPresetBundle(
    [preset('process', 'Draft'), preset('filament', 'Draft')],
    { timestamp: AT }
  )
  const paths = files.filter((file) => isPresetArchivePresetEntry(file.path)).map((file) => file.path)
  const baseNames = paths.map((path) => path.slice(path.lastIndexOf('/') + 1))
  assert.equal(new Set(baseNames).size, 2, `base names must be unique, got ${baseNames.join(', ')}`)
})

test('a name that cannot be a file name still produces a usable entry', () => {
  const { files, fileName } = buildSlicingPresetBundle(
    [preset('process', '../../etc/passwd')],
    { timestamp: AT }
  )
  const [entry] = files.filter((file) => isPresetArchivePresetEntry(file.path))
  assert.ok(entry)
  assert.doesNotMatch(entry.path, /\.\./, 'an entry path must not be able to escape its directory')
  assert.doesNotMatch(fileName, /[/\\]/, 'the download name must not contain a path separator')
})

test('an empty selection is refused rather than producing an empty archive', () => {
  assert.throws(() => buildSlicingPresetBundle([], { timestamp: AT }), /at least one preset/)
})
