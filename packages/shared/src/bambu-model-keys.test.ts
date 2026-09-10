import assert from 'node:assert/strict'
import test from 'node:test'
import { bambuModelKeysAreCompatible, canonicalBambuModelKey, normalizeBambuStudioPrinterModelOption, resolveBambuPrinterModelAliases } from './bambu-model-keys.js'

test('normalizeBambuStudioPrinterModelOption maps raw H2D ids to the H2D label', () => {
  assert.equal(normalizeBambuStudioPrinterModelOption('O1D'), 'H2D')
  assert.equal(normalizeBambuStudioPrinterModelOption('BL-D001'), 'H2D')
})

test('resolveBambuPrinterModelAliases includes raw slicer ids for H2D matching', () => {
  assert.deepEqual(resolveBambuPrinterModelAliases('H2D'), ['H2D', 'O1D', 'BL-D001'])
})

test('canonicalBambuModelKey keeps H2D and H2D Pro distinct', () => {
  assert.equal(canonicalBambuModelKey('Bambu Lab H2D 0.4 nozzle'), 'H2D')
  assert.equal(canonicalBambuModelKey('Bambu Lab H2D Pro 0.4 nozzle'), 'H2DPRO')
  assert.equal(canonicalBambuModelKey('H2DP'), 'H2DPRO')
  assert.equal(canonicalBambuModelKey('Qidi X-Plus 4 0.4 nozzle'), null)
  assert.equal(canonicalBambuModelKey('unknown'), null)
})

test('bambuModelKeysAreCompatible rejects an H2D Pro profile for an H2D printer', () => {
  assert.equal(bambuModelKeysAreCompatible('H2D', 'H2DPRO'), false)
  assert.equal(bambuModelKeysAreCompatible('H2D', 'H2D'), true)
})

test('bambuModelKeysAreCompatible treats the X1C-class family as compatible', () => {
  assert.equal(bambuModelKeysAreCompatible('P1P', 'X1C'), true)
  assert.equal(bambuModelKeysAreCompatible('P1S', 'X1C'), true)
  assert.equal(bambuModelKeysAreCompatible('X1E', 'X1'), true)
})

test('bambuModelKeysAreCompatible does not gate unknown/non-Bambu models', () => {
  assert.equal(bambuModelKeysAreCompatible(null, 'H2D'), true)
  assert.equal(bambuModelKeysAreCompatible('H2D', null), true)
})

test('bambuModelKeysAreCompatible rejects unrelated Bambu models', () => {
  assert.equal(bambuModelKeysAreCompatible('A1', 'A1mini'), false)
  assert.equal(bambuModelKeysAreCompatible('H2D', 'X1C'), false)
})
test('canonicalBambuModelKey detects A1 with a word boundary (no trailing space)', () => {
  assert.equal(canonicalBambuModelKey('Bambu Lab A1'), 'A1')
  assert.equal(canonicalBambuModelKey('A1'), 'A1')
  assert.equal(canonicalBambuModelKey('A11'), null)
})

test('bambuModelKeysAreCompatible treats X2D as cross-family with the X1C class', () => {
  assert.equal(bambuModelKeysAreCompatible('P1S', 'X2D'), false)
  assert.equal(bambuModelKeysAreCompatible('X1C', 'X2D'), false)
  assert.equal(bambuModelKeysAreCompatible('X2D', 'X2D'), true)
})

test('canonicalBambuModelKey returns printerModelSchema enum keys (bed-override round-trip)', () => {
  assert.equal(canonicalBambuModelKey('A1 mini'), 'A1mini')
  assert.equal(canonicalBambuModelKey('Bambu Lab A1 mini 0.4 nozzle'), 'A1mini')
  assert.equal(canonicalBambuModelKey('Bambu Lab X1 0.4 nozzle'), 'X1')
  assert.equal(canonicalBambuModelKey('X1'), 'X1')
  assert.equal(canonicalBambuModelKey('Bambu Lab X1 Carbon 0.4 nozzle'), 'X1C')
  assert.equal(canonicalBambuModelKey('Bambu Lab A2L 0.4 nozzle'), 'A2L')
})

test('Bambu device codes map to the model that actually bears them', () => {
  // Three of these were inverted for a long time, which is why they are pinned by name here as
  // well as re-derived from the vendored source below: `C11` is the P1P (not the X1C), `N1` is the
  // A1 mini and `N2S` the A1 (not the other way round). The consequence was quiet: these aliases
  // feed preset-name matching, so an X1C was offered a preset named for a P1P.
  assert.equal(normalizeBambuStudioPrinterModelOption('C11'), 'P1P')
  assert.equal(normalizeBambuStudioPrinterModelOption('C12'), 'P1S')
  assert.equal(normalizeBambuStudioPrinterModelOption('N1'), 'A1 mini')
  assert.equal(normalizeBambuStudioPrinterModelOption('N2S'), 'A1')
  assert.equal(normalizeBambuStudioPrinterModelOption('BL-P001'), 'X1C')
  assert.equal(normalizeBambuStudioPrinterModelOption('BL-P002'), 'X1')
  assert.equal(normalizeBambuStudioPrinterModelOption('N7'), 'P2S')
  assert.equal(normalizeBambuStudioPrinterModelOption('O1E'), 'H2D Pro')
  assert.equal(normalizeBambuStudioPrinterModelOption('O1S'), 'H2S')

  // The alias lists must agree with the label map, since both are consulted for matching.
  assert.ok(resolveBambuPrinterModelAliases('P1P').includes('C11'))
  assert.ok(!resolveBambuPrinterModelAliases('X1C').includes('C11'))
  assert.ok(resolveBambuPrinterModelAliases('A1mini').includes('N1'))
  assert.ok(resolveBambuPrinterModelAliases('A1').includes('N2S'))
})

/**
 * The ratchet for whoever bumps the vendored BambuStudio source: re-derive every device code from
 * `resources/printers/<code>.json`'s own `display_name` and require both of our tables to agree.
 *
 * SKIPS when the source is absent, exactly as the flush-model and blacklist guards do. Only codes
 * BambuStudio actually ships are checked, so the unverifiable `A04`/`A11`/`A12`/`A1M` entries are
 * neither asserted nor disturbed.
 */
test('our device-code tables still match the vendored BambuStudio resources', async (t) => {
  const { existsSync, readdirSync, readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  let root: string | null = null
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'packages')) && existsSync(join(dir, 'apps'))) { root = dir; break }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const printers = root ? join(root, 'tmp/bambustudio-src/resources/printers') : null
  if (!printers || !existsSync(printers)) {
    t.skip('vendored BambuStudio source not present')
    return
  }

  for (const file of readdirSync(printers)) {
    if (!file.endsWith('.json') || file === 'filaments_blacklist.json') continue
    const code = file.slice(0, -'.json'.length)
    const parsed = JSON.parse(readFileSync(join(printers, file), 'utf8')) as Record<string, { display_name?: string }>
    const displayName = parsed['00.00.00.00']?.display_name
    if (!displayName) continue
    const expectedKey = canonicalBambuModelKey(displayName)
    assert.ok(expectedKey, `${file}: display_name ${displayName} resolves to no model key`)

    assert.equal(
      canonicalBambuModelKey(normalizeBambuStudioPrinterModelOption(code)),
      expectedKey,
      `${code} should normalize to ${displayName}`
    )
    assert.ok(
      resolveBambuPrinterModelAliases(expectedKey).includes(code),
      `${expectedKey}'s aliases should include the device code ${code}`
    )
  }
})
