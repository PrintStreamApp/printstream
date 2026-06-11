import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import yazl from 'yazl'
import type { SlicingProfileSummary } from '@printstream/shared'
import { createCustomSlicingProfile, createCustomSlicingProfiles, listCustomSlicingProfiles } from './slicing-profiles.js'
import { rootPrisma } from './prisma.js'

const originalFindUnique = rootPrisma.setting.findUnique
const originalUpsert = rootPrisma.setting.upsert

afterEach(() => {
  rootPrisma.setting.findUnique = originalFindUnique
  rootPrisma.setting.upsert = originalUpsert
})

test('listCustomSlicingProfiles inherits metadata from built-in parent profiles', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'tenant.slicing.profiles.tenant-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  await createCustomSlicingProfile('tenant-1', {
    encoding: 'utf8',
    kind: 'process',
    content: JSON.stringify({
      type: 'process',
      name: 'Custom detail profile',
      inherits: '0.20mm Standard @BBL X1C',
      curr_bed_type: 'textured_pei_plate'
    })
  })

  const builtinParent: SlicingProfileSummary = {
    id: 'builtin:process:parent',
    source: 'builtin',
    kind: 'process',
    name: '0.20mm Standard @BBL X1C',
    compatiblePrinters: ['Bambu Lab X1 Carbon 0.4 nozzle'],
    nozzleDiameters: [0.4],
    plateTypes: ['cool_plate'],
    updatedAt: null
  }
  const profiles = await listCustomSlicingProfiles('tenant-1', [builtinParent])

  assert.equal(profiles.length, 1)
  assert.deepEqual(profiles[0]?.compatiblePrinters, ['Bambu Lab X1 Carbon 0.4 nozzle'])
  assert.deepEqual(profiles[0]?.nozzleDiameters, [0.4])
  assert.deepEqual(profiles[0]?.plateTypes, ['textured_pei_plate'])
})

test('createCustomSlicingProfile detects BambuStudio printer presets from settings ids', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'tenant.slicing.profiles.tenant-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  const profile = await createCustomSlicingProfile('tenant-1', {
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

test('createCustomSlicingProfiles imports BambuStudio preset archives', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'tenant.slicing.profiles.tenant-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  const archiveBase64 = await createPresetArchiveBase64([
    ['printer/printer.json', { name: 'Printer A', printer_settings_id: '' }],
    ['filament/filament.json', { name: 'Material A', filament_settings_id: ['f1'] }],
    ['bundle_structure.json', { bundle_type: 'printer config bundle' }]
  ])

  const { profiles } = await createCustomSlicingProfiles('tenant-1', {
    encoding: 'base64',
    content: archiveBase64
  })

  assert.equal(profiles.length, 2)
  assert.deepEqual(profiles.map((profile) => `${profile.kind}:${profile.name}`).sort(), [
    'filament:Material A',
    'machine:Printer A'
  ])
})

test('createCustomSlicingProfiles reports same-name collisions and overwrites only with overwrite', async () => {
  let settingValue: string | null = null
  rootPrisma.setting.findUnique = (async () => settingValue ? { key: 'tenant.slicing.profiles.tenant-1', value: settingValue } : null) as typeof rootPrisma.setting.findUnique
  rootPrisma.setting.upsert = (async (args) => {
    settingValue = typeof args.update.value === 'string' ? args.update.value : null
    return { key: args.where.key, value: settingValue }
  }) as typeof rootPrisma.setting.upsert

  const first = await createCustomSlicingProfiles('tenant-1', {
    fileName: '0.20mm Custom.json',
    encoding: 'utf8',
    content: JSON.stringify({ name: '0.20mm Custom', type: 'process', layer_height: '0.2' })
  })
  assert.deepEqual(first.conflicts, [])
  assert.equal(first.profiles.length, 1)

  // Without overwrite, a same-name upload is blocked and reported as a conflict (nothing written).
  const blocked = await createCustomSlicingProfiles('tenant-1', {
    fileName: '0.20mm Custom.json',
    encoding: 'utf8',
    content: JSON.stringify({ name: '0.20mm Custom', type: 'process', layer_height: '0.3' })
  })
  assert.deepEqual(blocked.conflicts, ['0.20mm Custom'])
  assert.equal(blocked.profiles.length, 0)
  assert.equal((await listCustomSlicingProfiles('tenant-1')).filter((profile) => profile.name === '0.20mm Custom').length, 1)

  // With overwrite, the existing preset is replaced (not duplicated).
  const overwritten = await createCustomSlicingProfiles('tenant-1', {
    fileName: '0.20mm Custom.json',
    encoding: 'utf8',
    content: JSON.stringify({ name: '0.20mm Custom', type: 'process', layer_height: '0.3' }),
    overwrite: true
  })
  assert.deepEqual(overwritten.replaced, ['0.20mm Custom'])
  assert.deepEqual(overwritten.conflicts, [])
  assert.equal((await listCustomSlicingProfiles('tenant-1')).filter((profile) => profile.name === '0.20mm Custom').length, 1)
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
