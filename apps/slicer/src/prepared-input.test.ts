/**
 * Runtime boundary for browser-prepared projects.
 *
 * The request intentionally contradicts the embedded identities and colours: if the legacy
 * metadata path runs, these assertions fail. The browser-prepared archive must reach the engine
 * byte-for-byte; only its authored manual map is read back for the CLI argument.
 */
import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import yazl from 'yazl'
import { prepareInputThreeMf } from './index.js'

async function writeThreeMf(dir: string, entries: Record<string, string>): Promise<string> {
  const filePath = path.join(dir, 'prepared.3mf')
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

test('browser-prepared-v1 reaches the engine unchanged and carries its manual map to the CLI', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-prepared-input-'))
  try {
    const authoredSettings = {
      printer_settings_id: ['Browser machine'],
      print_settings_id: ['Browser process'],
      filament_settings_id: ['Browser PLA', 'Browser PETG'],
      filament_type: ['PLA', 'PETG'],
      filament_colour: ['#112233', '#445566'],
      physical_extruder_map: ['1', '0'],
      filament_nozzle_map: ['1', '0'],
      filament_map_mode: 'Manual',
      filament_map: ['1', '2']
    }
    const authoredSettingsJson = `${JSON.stringify(authoredSettings)}\n`
    const sourcePath = await writeThreeMf(dir, {
      'Metadata/project_settings.config': authoredSettingsJson,
      'Metadata/model_settings.config': '<config><plate><metadata key="filament_map_mode" value="Manual"/><metadata key="filament_maps" value="1 2"/></plate></config>',
      'Metadata/slice_info.config': '<config><plate><filament id="1" type="PLA"/></plate></config>'
    })
    const outputPath = path.join(dir, 'mechanical.3mf')
    const outputLines: Array<{ stream: 'system' | 'stdout' | 'stderr'; text: string; createdAt: string }> = []
    const result = await prepareInputThreeMf({
      slicerTarget: { id: 'test', profileDir: '/must-not-be-read' } as never,
      inputPath: sourcePath,
      outputPath,
      request: {
        sourceFileId: 'project',
        preparedSource: { id: 'prepared-proof', contractVersion: 1 },
        target: {
          mode: 'manualProfile',
          printerModel: 'Contradictory request machine',
          printerProfileId: 'request-machine',
          processProfileId: 'request-process',
          filamentMappings: [
            { projectFilamentId: 1, material: 'ABS', color: '#FFFFFF', toolheadId: 'nozzle-0', source: 'manual' }
          ]
        },
        plate: 0
      } as never,
      profileFiles: [
        { id: 'request-machine', kind: 'machine', name: 'Request machine' },
        { id: 'request-process', kind: 'process', name: 'Request process' }
      ] as never,
      stripEmbeddedProfileRefs: true,
      processSettingOverrides: { layer_height: '9.9' },
      outputLines
    })

    assert.equal(result.inputPath, sourcePath)
    assert.equal(result.rewroteProjectSettings, false)
    assert.deepEqual(result.manualFilamentMap, ['1', '2'])
    await assert.rejects(
      stat(outputPath),
      /ENOENT/,
      'the runtime must not materialize another prepared copy'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
