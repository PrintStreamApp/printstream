import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import yazl from 'yazl'
import type { SlicingPresetSummary } from '@printstream/shared'
import { createCustomSlicingPreset, createCustomSlicingPresets, listCustomSlicingPresets } from './slicing-presets.js'
import { rootPrisma } from './prisma.js'

const originalFindUnique = rootPrisma.setting.findUnique
const originalUpsert = rootPrisma.setting.upsert

afterEach(() => {
  rootPrisma.setting.findUnique = originalFindUnique
  rootPrisma.setting.upsert = originalUpsert
})

test('listCustomSlicingPresets inherits metadata from built-in parent profiles', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'workspace.slicing.profiles.workspace-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  await createCustomSlicingPreset('workspace-1', {
    encoding: 'utf8',
    kind: 'process',
    content: JSON.stringify({
      type: 'process',
      name: 'Custom detail profile',
      inherits: '0.20mm Standard @BBL X1C',
      curr_bed_type: 'textured_pei_plate'
    })
  })

  const builtinParent: SlicingPresetSummary = {
    id: 'builtin:process:parent',
    source: 'builtin',
    kind: 'process',
    name: '0.20mm Standard @BBL X1C',
    compatiblePrinters: ['Bambu Lab X1 Carbon 0.4 nozzle'],
    nozzleDiameters: [0.4],
    plateTypes: ['cool_plate'],
    updatedAt: null
  }
  const profiles = await listCustomSlicingPresets('workspace-1', [builtinParent])

  assert.equal(profiles.length, 1)
  assert.deepEqual(profiles[0]?.compatiblePrinters, ['Bambu Lab X1 Carbon 0.4 nozzle'])
  assert.deepEqual(profiles[0]?.nozzleDiameters, [0.4])
  assert.deepEqual(profiles[0]?.plateTypes, ['textured_pei_plate'])
})

test('createCustomSlicingPreset detects BambuStudio printer presets from settings ids', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'workspace.slicing.profiles.workspace-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  const profile = await createCustomSlicingPreset('workspace-1', {
    encoding: 'utf8',
    content: JSON.stringify({
      name: 'Printer preset',
      printer_settings_id: ''
    })
  })

  assert.equal(profile.kind, 'machine')
  assert.equal(profile.name, 'Printer preset')
  const storedProfiles = JSON.parse(settingValue ?? '[]') as Array<{ content: string }>
  const storedRecord = JSON.parse(storedProfiles[0]?.content ?? '{}') as Record<string, unknown>
  assert.equal(storedRecord.type, 'machine')
})

test('createCustomSlicingPresets imports BambuStudio preset archives', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'workspace.slicing.profiles.workspace-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  const archiveBase64 = await createPresetArchiveBase64([
    ['printer/printer.json', { name: 'Printer A', printer_settings_id: '' }],
    ['filament/filament.json', { name: 'Material A', filament_settings_id: ['f1'] }],
    ['bundle_structure.json', { bundle_type: 'printer config bundle' }]
  ])

  const { profiles } = await createCustomSlicingPresets('workspace-1', {
    encoding: 'base64',
    content: archiveBase64
  })

  assert.equal(profiles.length, 2)
  assert.deepEqual(profiles.map((profile) => `${profile.kind}:${profile.name}`).sort(), [
    'filament:Material A',
    'machine:Printer A'
  ])
})

test('createCustomSlicingPresets reports same-name collisions and overwrites only with overwrite', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'workspace.slicing.profiles.workspace-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  const first = await createCustomSlicingPresets('workspace-1', {
    fileName: '0.20mm Custom.json',
    encoding: 'utf8',
    content: JSON.stringify({ name: '0.20mm Custom', type: 'process', layer_height: '0.2' })
  })
  assert.deepEqual(first.conflicts, [])
  assert.equal(first.profiles.length, 1)

  // Without overwrite, a same-name upload is blocked and reported as a conflict (nothing written).
  const blocked = await createCustomSlicingPresets('workspace-1', {
    fileName: '0.20mm Custom.json',
    encoding: 'utf8',
    content: JSON.stringify({ name: '0.20mm Custom', type: 'process', layer_height: '0.3' })
  })
  assert.deepEqual(blocked.conflicts, ['0.20mm Custom'])
  assert.equal(blocked.profiles.length, 0)
  assert.equal((await listCustomSlicingPresets('workspace-1')).filter((profile) => profile.name === '0.20mm Custom').length, 1)

  // With overwrite, the existing preset is replaced (not duplicated).
  const overwritten = await createCustomSlicingPresets('workspace-1', {
    fileName: '0.20mm Custom.json',
    encoding: 'utf8',
    content: JSON.stringify({ name: '0.20mm Custom', type: 'process', layer_height: '0.3' }),
    overwrite: true
  })
  assert.deepEqual(overwritten.replaced, ['0.20mm Custom'])
  assert.deepEqual(overwritten.conflicts, [])
  assert.equal((await listCustomSlicingPresets('workspace-1')).filter((profile) => profile.name === '0.20mm Custom').length, 1)
})

test('overwriting a preset keeps its id so references to it survive the edit', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'workspace.slicing.profiles.workspace-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  const created = await createCustomSlicingPresets('workspace-1', {
    encoding: 'utf8',
    content: JSON.stringify({ name: 'Shared process', type: 'process', layer_height: '0.2' })
  })
  const originalId = created.profiles[0]?.id
  assert.ok(originalId)

  const overwritten = await createCustomSlicingPresets('workspace-1', {
    encoding: 'utf8',
    content: JSON.stringify({ name: 'Shared process', type: 'process', layer_height: '0.3' }),
    overwrite: true
  })

  // The id is what every saved reference points at, a slice request, a print job's chosen
  // preset, and the Bambu-cloud sync map. Re-minting it on each save silently orphans all of them.
  assert.equal(overwritten.profiles[0]?.id, originalId)
  const listed = await listCustomSlicingPresets('workspace-1')
  assert.deepEqual(listed.map((profile) => profile.id), [originalId])
})

test('a preset keeps its id only within its own kind', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'workspace.slicing.profiles.workspace-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  const process = await createCustomSlicingPresets('workspace-1', {
    encoding: 'utf8',
    content: JSON.stringify({ name: 'Same name', type: 'process', layer_height: '0.2' })
  })
  const filament = await createCustomSlicingPresets('workspace-1', {
    encoding: 'utf8',
    content: JSON.stringify({ name: 'Same name', type: 'filament', filament_settings_id: ['f1'] })
  })

  assert.notEqual(filament.profiles[0]?.id, process.profiles[0]?.id)
  assert.deepEqual(filament.conflicts, [])
  assert.equal((await listCustomSlicingPresets('workspace-1')).length, 2)
})

async function createPresetArchiveBase64(entries: Array<[string, Record<string, unknown>]>): Promise<string> {
  const zip = new yazl.ZipFile()
  for (const [entryPath, payload] of entries) {
    zip.addBuffer(Buffer.from(JSON.stringify(payload)), entryPath)
  }

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zip.outputStream.on('error', reject)
    zip.end()
  })

  return buffer.toString('base64')
}

// Seam: a workspace preset inherits its parent's identity fields, and an explicit
// override on the child wins. `filament_is_support` is the one where absent-vs-false
// matters, an omitted false would let an inherited `true` leak through the `??` merge
// and type a model filament as support (issue #66).
test('listCustomSlicingPresets inherits the support flag and lets a child override it off', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'workspace.slicing.profiles.workspace-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  await createCustomSlicingPresets('workspace-1', {
    encoding: 'utf8',
    kind: 'filament',
    content: JSON.stringify({
      type: 'filament',
      name: 'My support blend',
      inherits: 'Bambu Support For PLA @BBL H2D'
    })
  })
  await createCustomSlicingPresets('workspace-1', {
    encoding: 'utf8',
    kind: 'filament',
    content: JSON.stringify({
      type: 'filament',
      name: 'My model blend',
      inherits: 'Bambu Support For PLA @BBL H2D',
      filament_is_support: ['0']
    })
  })

  const builtinParent: SlicingPresetSummary = {
    id: 'builtin:filament:support-pla',
    source: 'builtin',
    kind: 'filament',
    name: 'Bambu Support For PLA @BBL H2D',
    filamentType: 'PLA',
    filamentIsSupport: true,
    filamentIds: ['GFS02'],
    updatedAt: null
  }
  const profiles = await listCustomSlicingPresets('workspace-1', [builtinParent])
  const inherited = profiles.find((profile) => profile.name === 'My support blend')
  const overridden = profiles.find((profile) => profile.name === 'My model blend')

  assert.equal(inherited?.filamentIsSupport, true)
  assert.equal(inherited?.filamentType, 'PLA')
  assert.equal(overridden?.filamentIsSupport, false)
})

// Seam: process presets inherit the real layer height rather than leaving the slice
// picker to scrape a `0.20mm` token out of a name the user may have renamed.
test('listCustomSlicingPresets inherits layerHeight from a built-in parent', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'workspace.slicing.profiles.workspace-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  await createCustomSlicingPreset('workspace-1', {
    encoding: 'utf8',
    kind: 'process',
    content: JSON.stringify({ type: 'process', name: 'Ryan fine', inherits: '0.20mm Standard @BBL X1C' })
  })

  const profiles = await listCustomSlicingPresets('workspace-1', [{
    id: 'builtin:process:parent',
    source: 'builtin',
    kind: 'process',
    name: '0.20mm Standard @BBL X1C',
    layerHeight: 0.2,
    updatedAt: null
  }])

  assert.equal(profiles[0]?.layerHeight, 0.2)
})

// The web resolver needs to tell a derivative from the preset it was derived from: a child inherits
// its parent's `filament_id`, so identity alone cannot separate them, and an AMS tray reporting
// GFA00 matched a user's "Bambu PLA Basic - Cryogrip Pro Glacier" as readily as the built-in.
// `derivedFromPresetName` is that signal, and it is IDENTITY, a child of a child names its own
// immediate parent and must never inherit its grandparent's value through the metadata merge.
test('a custom profile reports the preset it inherits from, never its parent\'s', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'workspace.slicing.profiles.workspace-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  await createCustomSlicingPreset('workspace-1', {
    encoding: 'utf8',
    kind: 'filament',
    content: JSON.stringify({ type: 'filament', name: 'Bambu PLA Basic - Custom', inherits: 'Bambu PLA Basic @BBL H2D' })
  })
  await createCustomSlicingPreset('workspace-1', {
    encoding: 'utf8',
    kind: 'filament',
    content: JSON.stringify({ type: 'filament', name: 'Bambu PLA Basic - Cryogrip Pro Glacier', inherits: 'Bambu PLA Basic - Custom' })
  })

  const builtinParent: SlicingPresetSummary = {
    id: 'builtin:filament:pla-basic',
    source: 'builtin',
    kind: 'filament',
    name: 'Bambu PLA Basic @BBL H2D',
    filamentIds: ['GFA00'],
    filamentType: 'PLA',
    updatedAt: null
  }
  const profiles = await listCustomSlicingPresets('workspace-1', [builtinParent])

  const child = profiles.find((profile) => profile.name === 'Bambu PLA Basic - Cryogrip Pro Glacier')
  const parent = profiles.find((profile) => profile.name === 'Bambu PLA Basic - Custom')
  assert.equal(child?.derivedFromPresetName, 'Bambu PLA Basic - Custom')
  assert.equal(parent?.derivedFromPresetName, 'Bambu PLA Basic @BBL H2D')
  // The child still inherits the METADATA it needs (the shared filament id that made the two
  // indistinguishable in the first place), only the derived-from relation stays per-preset.
  assert.deepEqual(child?.filamentIds, ['GFA00'])
})
