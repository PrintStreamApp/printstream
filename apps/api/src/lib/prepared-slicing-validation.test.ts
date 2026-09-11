import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildBuiltinSlicingPresetId, type SlicingTarget } from '@printstream/shared'
import yazl from 'yazl'
import { validatePreparedSlicingProject } from './prepared-slicing-validation.js'
import { validateZipArchiveLimits } from './three-mf-internal.js'

const MACHINE_NAME = 'Bambu Lab P1S 0.4 nozzle'
const PROCESS_NAME = '0.20mm Standard @BBL P1S'
const FILAMENT_NAME = 'Bambu PLA Basic @BBL P1S'

const target: SlicingTarget = {
  mode: 'manualProfile',
  printerModel: 'P1S',
  printerProfileId: buildBuiltinSlicingPresetId('machine', MACHINE_NAME),
  processProfileId: buildBuiltinSlicingPresetId('process', PROCESS_NAME),
  processSettingOverrides: { layer_height: '0.2' },
  machineSettingOverrides: { printable_height: '256' },
  filamentSettingOverrides: { filament_flow_ratio: '0.99' },
  filamentMappings: [{
    projectFilamentId: 1,
    profileId: buildBuiltinSlicingPresetId('filament', FILAMENT_NAME),
    materialType: 'PLA',
    material: 'Bambu PLA Basic',
    color: '#FFFFFF',
    source: 'manual',
    toolheadId: 'nozzle-0',
    settingOverrides: { nozzle_temperature: '225' }
  }],
  plateType: 'textured_pei_plate'
}

test('accepts a complete welded project that carries the selected target', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prepared-validation-valid-'))
  try {
    const projectPath = await writeProject(dir)
    await validatePreparedSlicingProject({ projectPath, target })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects malformed or incomplete prepared archives before proof issuance', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prepared-validation-malformed-'))
  try {
    const invalidJson = await writeProject(dir, {
      fileName: 'invalid-json.3mf',
      projectSettings: '{not json'
    })
    await assert.rejects(
      validatePreparedSlicingProject({ projectPath: invalidJson, target }),
      /unreadable project settings/
    )

    const missingLoaderGate = await writeProject(dir, {
      fileName: 'missing-marker.3mf',
      rootModel: ROOT_MODEL.replace('BambuStudio-02.00.00.00', 'OtherSlicer-1')
    })
    await assert.rejects(
      validatePreparedSlicingProject({ projectPath: missingLoaderGate, target }),
      /missing its BambuStudio application marker/
    )

    const missingRequiredEntry = await writeProject(dir, {
      fileName: 'missing-rels.3mf',
      omit: '3D/_rels/3dmodel.model.rels'
    })
    await assert.rejects(
      validatePreparedSlicingProject({ projectPath: missingRequiredEntry, target }),
      /incomplete or unreadable/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects target identities and mappings not present in the staged project', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prepared-validation-target-'))
  try {
    for (const [name, mutate, expected] of [
      ['machine', (settings: Record<string, unknown>) => { settings.printer_settings_id = 'Another machine' }, /selected machine preset/],
      ['process', (settings: Record<string, unknown>) => { settings.print_settings_id = 'Another process' }, /selected process preset/],
      ['filament', (settings: Record<string, unknown>) => { settings.filament_settings_id = ['Another filament'] }, /selected preset/],
      ['material', (settings: Record<string, unknown>) => { settings.filament_type = ['ABS'] }, /Material 1 is ABS, but PLA was selected/],
      ['nozzle', (settings: Record<string, unknown>) => { settings.filament_nozzle_map = ['1'] }, /selected nozzle/],
      ['override', (settings: Record<string, unknown>) => { settings.layer_height = '0.28' }, /selected process setting/]
    ] as const) {
      const settings = validSettings()
      mutate(settings)
      const projectPath = await writeProject(dir, { fileName: `${name}.3mf`, projectSettings: JSON.stringify(settings) })
      await assert.rejects(validatePreparedSlicingProject({ projectPath, target }), expected)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects an inherited manual map when the frozen target uses automatic routing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prepared-validation-stale-manual-'))
  try {
    const settings = validSettings()
    settings.filament_map_mode = 'Manual'
    settings.filament_map = ['1']
    const projectPath = await writeProject(dir, {
      projectSettings: JSON.stringify(settings),
      modelSettings: '<config><plate><metadata key="plater_id" value="1"/><metadata key="filament_map_mode" value="Manual"/><metadata key="filament_maps" value="1"/></plate></config>'
    })
    const automaticTarget: SlicingTarget = {
      ...target,
      filamentMappings: target.filamentMappings?.map((mapping) => ({ ...mapping, toolheadId: null }))
    }
    await assert.rejects(
      validatePreparedSlicingProject({ projectPath, target: automaticTarget }),
      /manual nozzle assignment that was not selected/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validates slot-two overrides after a non-uniform 2+3 variant block', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prepared-validation-variant-rows-'))
  try {
    const settings = validSettings()
    settings.filament_settings_id = [FILAMENT_NAME, 'Bambu TPU 95A @BBL P1S']
    settings.filament_ids = ['GFA00', 'GFU01']
    settings.filament_type = ['PLA', 'TPU']
    settings.filament_colour = ['#FFFFFF', '#000000']
    settings.filament_nozzle_map = ['0', '0']
    settings.filament_diameter = ['1.75', '1.75']
    settings.filament_extruder_variant = ['DDS', 'DDHF', 'DDS', 'DDHF', 'TPUHF']
    settings.filament_self_index = ['1', '1', '2', '2', '2']
    settings.filament_max_volumetric_speed = ['20', '30', '5', '7', '9']
    const variantTarget: SlicingTarget = {
      ...target,
      filamentSettingOverrides: undefined,
      filamentMappings: [
        { ...target.filamentMappings![0]!, settingOverrides: undefined },
        {
          projectFilamentId: 2,
          materialType: 'TPU',
          color: '#000000',
          source: 'manual',
          settingOverrides: { filament_max_volumetric_speed: ['5', '7', '9'] }
        }
      ]
    }
    const projectPath = await writeProject(dir, { projectSettings: JSON.stringify(settings) })
    await validatePreparedSlicingProject({ projectPath, target: variantTarget })

    settings.filament_max_volumetric_speed = ['20', '30', '5', '7', 'wrong']
    const wrongPath = await writeProject(dir, { fileName: 'wrong-variant.3mf', projectSettings: JSON.stringify(settings) })
    await assert.rejects(
      validatePreparedSlicingProject({ projectPath: wrongPath, target: variantTarget }),
      /Material 2 is missing the selected setting filament_max_volumetric_speed/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bounds prepared ZIP entry count and aggregate inflated bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prepared-validation-limits-'))
  try {
    const projectPath = await writeProject(dir)
    await assert.rejects(
      validateZipArchiveLimits(projectPath, { maxEntries: 5, maxUncompressedBytes: 1024 * 1024 }),
      /too many entries/
    )
    await assert.rejects(
      validateZipArchiveLimits(projectPath, { maxEntries: 100, maxUncompressedBytes: 32 }),
      /expands beyond the allowed size/
    )

    const underdeclaredPath = path.join(dir, 'underdeclared.3mf')
    const underdeclared = await readFile(projectPath)
    for (let offset = 0; offset <= underdeclared.length - 28; offset += 1) {
      if (underdeclared.readUInt32LE(offset) === 0x02014b50) underdeclared.writeUInt32LE(0, offset + 24)
    }
    await writeFile(underdeclaredPath, underdeclared)
    await assert.rejects(
      validateZipArchiveLimits(underdeclaredPath, { maxEntries: 100, maxUncompressedBytes: 64 }),
      /expands beyond the allowed size/,
      'the emitted byte counter rejects an archive whose central directory under-declares every entry'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('does not repeat the browser mesh weld while issuing a proof', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prepared-validation-weld-'))
  try {
    const projectPath = await writeProject(dir, { fileName: 'unwelded.3mf', rootModel: UNWELDED_ROOT_MODEL })
    await validatePreparedSlicingProject({ projectPath, target })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const ROOT_MODEL = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter">',
  '  <metadata name="Application">BambuStudio-02.00.00.00</metadata>',
  '  <resources>',
  '    <object id="1" type="model"><mesh>',
  '      <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>',
  '      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>',
  '    </mesh></object>',
  '  </resources>',
  '  <build><item objectid="1"/></build>',
  '</model>'
].join('\n')

const UNWELDED_ROOT_MODEL = ROOT_MODEL
  .replace(
    '<vertex x="0" y="1" z="0"/></vertices>',
    '<vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="0"/></vertices>'
  )
  .replace('</triangles>', '<triangle v1="3" v2="1" v3="2"/></triangles>')

function validSettings(): Record<string, unknown> {
  return {
    printer_settings_id: MACHINE_NAME,
    printer_model: 'P1S',
    print_settings_id: PROCESS_NAME,
    curr_bed_type: 'Textured PEI Plate',
    layer_height: '0.2',
    printable_height: '256',
    nozzle_diameter: ['0.4'],
    physical_extruder_map: ['0'],
    filament_settings_id: [FILAMENT_NAME],
    filament_ids: ['GFA00'],
    filament_type: ['PLA'],
    filament_colour: ['#FFFFFF'],
    filament_nozzle_map: ['0'],
    nozzle_temperature: ['225'],
    nozzle_temperature_initial_layer: ['220'],
    filament_flow_ratio: ['0.99'],
    filament_density: ['1.24'],
    filament_diameter: ['1.75']
  }
}

async function writeProject(dir: string, options: {
  fileName?: string
  projectSettings?: string
  rootModel?: string
  modelSettings?: string
  omit?: string
} = {}): Promise<string> {
  const filePath = path.join(dir, options.fileName ?? 'project.3mf')
  const entries: Record<string, string> = {
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    '3D/3dmodel.model': options.rootModel ?? ROOT_MODEL,
    '3D/_rels/3dmodel.model.rels': '<Relationships/>',
    'Metadata/model_settings.config': options.modelSettings ?? '<config><plate><metadata key="plater_id" value="1"/></plate></config>',
    'Metadata/project_settings.config': options.projectSettings ?? JSON.stringify(validSettings())
  }
  if (options.omit) delete entries[options.omit]

  const zip = new yazl.ZipFile()
  const output = createWriteStream(filePath)
  zip.outputStream.pipe(output)
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name)
  zip.end()
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
  })
  return filePath
}
