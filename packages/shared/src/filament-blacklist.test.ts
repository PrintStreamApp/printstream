import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  blacklistProhibitions,
  blacklistWarnings,
  checkFilamentBlacklist,
  filamentBlacklistRefusalMessage,
  isExternalSpoolTrayIndex,
  type FilamentBlacklistQuery
} from './filament-blacklist.js'
import {
  canonicalBambuModelKey,
  normalizeBambuStudioPrinterModelOption
} from './bambu-model-keys.js'
import {
  BAMBU_MODEL_CODE_TO_MODEL_KEY,
  FILAMENT_BLACKLIST_RULES
} from './generated/filament-blacklist.generated.js'

/**
 * A query with nothing known, so each test states only the fields its rule keys on.
 *
 * Defaulting to "unknown everywhere" is deliberate: it makes the two opposite unknown-handling
 * rules (flow vs diameter) visible in the tests that exercise them rather than hidden behind a
 * convenient fixture.
 */
function query(overrides: Partial<FilamentBlacklistQuery> = {}): FilamentBlacklistQuery {
  return {
    printerModel: 'H2D',
    filamentId: null,
    filamentType: null,
    filamentName: null,
    filamentVendor: null,
    nozzleFlow: null,
    nozzleDiameter: null,
    extruderId: null,
    externalSpool: false,
    hasFilamentSwitch: false,
    calibMode: null,
    usedForSupport: null,
    usedForObject: null,
    ...overrides
  }
}

test('TPU in an AMS slot is prohibited, but the same spool mounted externally is not', () => {
  const inAms = checkFilamentBlacklist(query({ filamentType: 'TPU', externalSpool: false }))
  assert.equal(blacklistProhibitions(inAms).length, 1)
  assert.equal(blacklistProhibitions(inAms)[0]?.message, 'TPU is not supported by AMS.')

  const external = checkFilamentBlacklist(query({ filamentType: 'TPU', externalSpool: true }))
  assert.deepEqual(blacklistProhibitions(external), [])
})

test('material type matching is case-insensitive', () => {
  const lower = checkFilamentBlacklist(query({ filamentType: 'tpu' }))
  const upper = checkFilamentBlacklist(query({ filamentType: 'TPU' }))
  assert.deepEqual(lower, upper)
})

test('the E3D high-flow rules target the P1 series and X1C, the models that bear those codes', () => {
  // The rules name model codes C11/C12/BL-P001, and BambuStudio's own resources say C11 is the
  // P1P. This was inverted in `bambu-model-keys.ts` for a long time, so it is pinned here too.
  assert.equal(BAMBU_MODEL_CODE_TO_MODEL_KEY['C11'], 'P1P')
  assert.equal(BAMBU_MODEL_CODE_TO_MODEL_KEY['C12'], 'P1S')
  assert.equal(BAMBU_MODEL_CODE_TO_MODEL_KEY['BL-P001'], 'X1C')

  const onP1P = checkFilamentBlacklist(query({
    printerModel: 'P1P',
    filamentName: 'Bambu PA6-GF',
    nozzleFlow: 'high'
  }))
  assert.equal(blacklistProhibitions(onP1P).length, 1)
  assert.match(blacklistProhibitions(onP1P)[0]!.message, /E3D high-flow nozzle/)

  // An A1 is not in that rule's model list, so the same spool and nozzle raise nothing.
  const onA1 = checkFilamentBlacklist(query({
    printerModel: 'A1',
    filamentName: 'Bambu PA6-GF',
    nozzleFlow: 'high'
  }))
  assert.deepEqual(blacklistProhibitions(onA1), [])
})

test('an unknown nozzle flow never matches a flow-constrained rule', () => {
  const known = checkFilamentBlacklist(query({
    printerModel: 'P1P',
    filamentName: 'Bambu PA6-GF',
    nozzleFlow: 'high'
  }))
  assert.equal(blacklistProhibitions(known).length, 1)

  const unknown = checkFilamentBlacklist(query({
    printerModel: 'P1P',
    filamentName: 'Bambu PA6-GF',
    nozzleFlow: null
  }))
  assert.deepEqual(blacklistProhibitions(unknown), [], 'an unparsed nozzle must not invent an E3D prohibition')
})

test('an unknown nozzle DIAMETER still matches a diameter-constrained rule', () => {
  // The opposite of the flow rule above, and deliberately so: Studio guards the diameter filter on
  // `has_value()`, so the material-level warning still reaches the user when we could not read the
  // nozzle. Pinned because "make these two consistent" is the obvious wrong refactor.
  const withDiameter = checkFilamentBlacklist(query({
    printerModel: 'H2D',
    filamentName: 'Bambu TPU 85A',
    nozzleFlow: 'high',
    nozzleDiameter: 0.4,
    externalSpool: true
  }))
  const withoutDiameter = checkFilamentBlacklist(query({
    printerModel: 'H2D',
    filamentName: 'Bambu TPU 85A',
    nozzleFlow: 'high',
    nozzleDiameter: null,
    externalSpool: true
  }))
  assert.ok(blacklistWarnings(withDiameter).length > 0)
  assert.deepEqual(withoutDiameter, withDiameter)
})

test('a diameter outside the rule list does not match', () => {
  const wrongDiameter = checkFilamentBlacklist(query({
    printerModel: 'H2D',
    filamentName: 'Bambu TPU 85A',
    nozzleFlow: 'high',
    nozzleDiameter: 1.0,
    externalSpool: true
  }))
  assert.deepEqual(blacklistWarnings(wrongDiameter), [])
})

test('a Bambu-only rule fires for BOTH spellings of the vendor', () => {
  // The rules carry BambuStudio's raw "Bambu Lab"; every caller here supplies the app's display
  // brand, "Bambu" (`normalizeFilamentVendorLabel` maps one to the other). Asserting only the raw
  // spelling is what let both vendor-gated rules ship dead: no adapter ever produces it.
  for (const vendor of ['Bambu Lab', 'Bambu', 'bambu lab', 'bambu']) {
    const findings = checkFilamentBlacklist(query({
      filamentVendor: vendor,
      filamentType: 'PET-CF',
      externalSpool: false
    }))
    assert.equal(blacklistProhibitions(findings).length, 1, `${vendor} should match the Bambu-only rule`)
    assert.equal(blacklistProhibitions(findings)[0]?.message, "AMS does not support 'Bambu Lab PET-CF'.")
  }
})

test('an unknown vendor reads as third party, so a Bambu-only rule does not fire', () => {
  const bambu = checkFilamentBlacklist(query({
    filamentVendor: 'Bambu',
    filamentType: 'PET-CF',
    externalSpool: false
  }))
  assert.equal(blacklistProhibitions(bambu).length, 1)

  const unknownVendor = checkFilamentBlacklist(query({
    filamentVendor: null,
    filamentType: 'PET-CF',
    externalSpool: false
  }))
  assert.deepEqual(blacklistProhibitions(unknownVendor), [])
})

test('a whitelisted filament id escapes its rule, case-sensitively', () => {
  const base = {
    printerModel: 'H2D',
    filamentType: 'PLA',
    nozzleFlow: 'tpu-high'
  } as const

  const notWhitelisted = checkFilamentBlacklist(query({ ...base, filamentId: 'GFA00' }))
  assert.equal(blacklistProhibitions(notWhitelisted).length, 1)
  assert.match(blacklistProhibitions(notWhitelisted)[0]!.message, /TPU high-flow nozzle/)

  const whitelisted = checkFilamentBlacklist(query({ ...base, filamentId: 'GFU04' }))
  assert.deepEqual(blacklistProhibitions(whitelisted), [])

  // Studio compares filament ids exactly, so the lower-case spelling is a different id.
  const wrongCase = checkFilamentBlacklist(query({ ...base, filamentId: 'gfu04' }))
  assert.equal(blacklistProhibitions(wrongCase).length, 1)
})

test('a Track Switch rule only fires when a switch is fitted', () => {
  const withSwitch = checkFilamentBlacklist(query({
    filamentType: 'PLA',
    filamentName: 'Bambu PLA Silk',
    hasFilamentSwitch: true
  }))
  assert.ok(withSwitch.some((finding) => /Filament Track Switch/.test(finding.message)))

  const withoutSwitch = checkFilamentBlacklist(query({
    filamentType: 'PLA',
    filamentName: 'Bambu PLA Silk',
    hasFilamentSwitch: false
  }))
  assert.ok(!withoutSwitch.some((finding) => /Filament Track Switch/.test(finding.message)))
})

test('%s is filled from the filament name, or the type where the rule says so', () => {
  const byName = checkFilamentBlacklist(query({
    filamentType: 'PLA',
    filamentName: 'Bambu PLA Silk',
    hasFilamentSwitch: true
  }))
  const switchFinding = byName.find((finding) => /Filament Track Switch/.test(finding.message))
  assert.equal(
    switchFinding?.message,
    'Bambu PLA Silk may fail to load or unload due to the Filament Track Switch. If you wish to continue.'
  )

  const byType = checkFilamentBlacklist(query({
    printerModel: 'H2D',
    filamentType: 'PLA-CF',
    nozzleFlow: 'high',
    nozzleDiameter: 0.4,
    externalSpool: false
  }))
  const amsFinding = byType.find((finding) => /hard and brittle/.test(finding.message))
  assert.ok(amsFinding?.message.startsWith('PLA-CF filaments are hard and brittle'))
})

test('an unknown filament name falls back to something that reads as English', () => {
  // Deliberate divergence from BambuStudio, which would render a leading empty substitution.
  const findings = checkFilamentBlacklist(query({
    printerModel: 'H2D',
    filamentType: null,
    filamentName: null,
    nozzleFlow: 'tpu-high',
    filamentId: 'GFA00'
  }))
  const prohibition = blacklistProhibitions(findings)[0]
  assert.ok(prohibition)
  assert.ok(!prohibition.message.includes('%s'))
  assert.ok(!prohibition.message.startsWith(' '))
})

test('rules sharing one description collapse to a single finding', () => {
  // Every E3D entry says the same sentence; a P1P with a high-flow nozzle and a PA6-GF spool
  // matches more than one of them.
  const findings = checkFilamentBlacklist(query({
    printerModel: 'P1P',
    filamentType: 'PPS-CF',
    filamentName: 'Generic PPS-CF',
    nozzleFlow: 'high'
  }))
  const messages = findings.map((finding) => finding.message)
  assert.equal(new Set(messages).size, messages.length)
})

test('a rule that names no printer applies to every printer', () => {
  // The cold-pull TPU advisory constrains nothing but the type, so it must reach an unknown model.
  const findings = checkFilamentBlacklist(query({ printerModel: 'unknown', filamentType: 'TPU', externalSpool: true }))
  assert.ok(findings.some((finding) => /cold pull/.test(finding.message)))
})

test('nothing matches when nothing is known', () => {
  assert.deepEqual(checkFilamentBlacklist(query()), [])
})

test('wiki links ride along with the findings that have them', () => {
  const findings = checkFilamentBlacklist(query({ printerModel: 'X2D', filamentType: 'TPU', externalSpool: true }))
  const feedGuide = findings.find((finding) => /How to feed TPU filament on X2D/.test(finding.message))
  assert.equal(feedGuide?.wikiUrl, 'https://e.bambulab.com/t?c=PAxXqQu2zBgvN3ea')
})

test('the refusal message names the slot and points at the dialog', () => {
  const findings = checkFilamentBlacklist(query({ filamentType: 'TPU' }))
  const message = filamentBlacklistRefusalMessage([{ slotLabel: 'AMS A Slot 2', findings }])
  assert.match(message, /AMS A Slot 2: TPU is not supported by AMS\./)
  assert.match(message, /confirm the unsupported combination in the print dialog/)
})

test('external spool tray indexes are 254 and 255', () => {
  assert.ok(isExternalSpoolTrayIndex(254))
  assert.ok(isExternalSpoolTrayIndex(255))
  assert.ok(!isExternalSpoolTrayIndex(0))
  assert.ok(!isExternalSpoolTrayIndex(128))
  assert.ok(!isExternalSpoolTrayIndex(null))
})

test('the generated code map agrees with the app-wide one', () => {
  // Two tables carry Bambu's device codes: this one (generated from Studio's resource files, used
  // to target rules) and `bambu-model-keys.ts` (hand-kept, used for name matching everywhere else).
  // If they drift, a rule silently applies to a different printer than the one the rest of the app
  // resolves that code to, which is exactly the shape of the bug that was there before.
  for (const [code, expected] of Object.entries(BAMBU_MODEL_CODE_TO_MODEL_KEY)) {
    assert.equal(
      canonicalBambuModelKey(normalizeBambuStudioPrinterModelOption(code)),
      expected,
      `${code} resolves differently in bambu-model-keys.ts`
    )
  }
})

test('every generated rule carries an action and a description', () => {
  assert.ok(FILAMENT_BLACKLIST_RULES.length > 0)
  for (const rule of FILAMENT_BLACKLIST_RULES) {
    assert.ok(rule.action === 'prohibition' || rule.action === 'warning')
    assert.ok(rule.description.length > 0)
    // A `%s` with no substitution would reach a user verbatim; the generator refuses to emit one.
    if (rule.description.includes('%s')) assert.ok(rule.substitution)
  }
})

test('a slot assignment is graded against the material being chosen, not the one loaded', async () => {
  const { checkFilamentBlacklistForAssignment } = await import('./filament-blacklist-slots.js')
  // The slot currently holds PLA; the user is picking TPU. The whole point of this call site is to
  // warn while the choice is still being made, so the PENDING material is what gets graded.
  const status = {
    externalSpools: [],
    nozzles: [],
    filamentTrackSwitch: null,
    ams: [{ unitId: 0, type: 'ams', nozzleId: null, slots: [{ slot: 0, filamentType: 'PLA' }] }]
  } as unknown as Parameters<typeof checkFilamentBlacklistForAssignment>[0]['status']

  const choosingTpu = checkFilamentBlacklistForAssignment({
    printerModel: 'P1S',
    status,
    amsId: 0,
    slotId: 0,
    filamentType: 'TPU',
    filamentId: null
  })
  assert.equal(blacklistProhibitions(choosingTpu).length, 1)
  assert.match(blacklistProhibitions(choosingTpu)[0]!.message, /TPU is not supported by AMS/)

  // Keeping PLA raises nothing, so the notice appears only while it is deserved.
  assert.deepEqual(checkFilamentBlacklistForAssignment({
    printerModel: 'P1S',
    status,
    amsId: 0,
    slotId: 0,
    filamentType: 'PLA',
    filamentId: null
  }), [])

  // A unit the printer does not report has no hardware context to grade against.
  assert.deepEqual(checkFilamentBlacklistForAssignment({
    printerModel: 'P1S',
    status,
    amsId: 9,
    slotId: 0,
    filamentType: 'TPU',
    filamentId: null
  }), [])
})

/** Walk up to the workspace root (the directory holding `packages/` and `apps/`). */
function findWorkspaceRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'packages')) && existsSync(join(dir, 'apps'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Guards the generated rules against vendor drift, the same way `flush-volume-calc.test.ts` guards
 * its model: re-derive from the vendored source and require an exact match.
 *
 * SKIPS when `tmp/bambustudio-src` is absent, which makes it a ratchet for whoever bumps the
 * vendored source, i.e. exactly whoever would introduce the drift.
 */
test('the generated blacklist still matches the vendored BambuStudio source', async (t) => {
  const root = findWorkspaceRoot()
  const src = root ? join(root, 'tmp', 'bambustudio-src') : null
  if (!src || !existsSync(join(src, 'resources/printers/filaments_blacklist.json'))) {
    t.skip('vendored BambuStudio source not present')
    return
  }
  const { extractFilamentBlacklist } = await import(
    join(root!, 'scripts/dev/generate-filament-blacklist.mjs')
  ) as { extractFilamentBlacklist: (src: string) => { rules: unknown; modelCodes: unknown } }
  const derived = extractFilamentBlacklist(src)
  assert.deepEqual(
    JSON.parse(JSON.stringify(FILAMENT_BLACKLIST_RULES)),
    JSON.parse(JSON.stringify(derived.rules)),
    'Re-run scripts/dev/generate-filament-blacklist.mjs: BambuStudio changed its filament blacklist'
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(BAMBU_MODEL_CODE_TO_MODEL_KEY)),
    JSON.parse(JSON.stringify(derived.modelCodes)),
    'Re-run scripts/dev/generate-filament-blacklist.mjs: BambuStudio changed its printer model codes'
  )
})
