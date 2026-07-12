import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import yazl from 'yazl'
import { createSinglePlateBridgeThreeMf, readBridgeLibraryThreeMfIndex } from './library-3mf.js'

test('readBridgeLibraryThreeMfIndex falls back to embedded plate thumbnails when slice-info is missing', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-thumbnail-plates-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/plate_1.png', Buffer.from('plate-one-preview')],
      ['Metadata/plate_2_small.png', Buffer.from('ignored-small-preview')],
      ['Metadata/plate_3.png', Buffer.from('plate-three-preview')]
    ])

    const index = await readBridgeLibraryThreeMfIndex(sourcePath)

    assert.deepEqual(index.plates.map((plate) => plate.index), [1, 3])
    assert.equal(index.plates[1]?.thumbnailFile, 'Metadata/plate_3.png')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readBridgeLibraryThreeMfIndex falls back to model-settings plates and default print profile when slice-info is missing', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-model-settings-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        '  <plate>',
        '    <metadata key="plater_id" value="1"/>',
        '    <metadata key="plater_name" value="Front Plate"/>',
        '    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>',
        '  </plate>',
        '  <plate>',
        '    <metadata key="plater_id" value="2"/>',
        '    <metadata key="plater_name" value="Rear Plate"/>',
        '    <metadata key="thumbnail_file" value="Metadata/plate_2.png"/>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        default_print_profile: 'Custom Project Process',
        printer_settings_id: 'Bambu Lab P1S 0.4 nozzle'
      }), 'utf8')]
    ])

    const index = await readBridgeLibraryThreeMfIndex(sourcePath)

    assert.deepEqual(index.plates.map((plate) => plate.index), [1, 2])
    assert.equal(index.plates[0]?.name, 'Front Plate')
    assert.equal(index.plates[1]?.name, 'Rear Plate')
    assert.equal(index.plates[1]?.thumbnailFile, 'Metadata/plate_2.png')
    assert.equal(index.processProfileName, 'Custom Project Process')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readBridgeLibraryThreeMfIndex exposes plate objects (by object_id) for unsliced 3MFs', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-objects-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        '  <object id="3"><metadata key="name" value="Box"/></object>',
        '  <object id="11"><metadata key="name" value="Lid"/></object>',
        '  <plate>',
        '    <metadata key="plater_id" value="1"/>',
        '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
        '    <model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="0"/></model_instance>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')]
    ])

    const index = await readBridgeLibraryThreeMfIndex(sourcePath)
    // These instances carry no identify_id (unsliced project), so the firmware skip
    // handles are empty; sliced projects fill them from each model_instance.
    assert.deepEqual(index.plates[0]?.objects, [
      { id: 3, name: 'Box', identifyIds: [] },
      { id: 11, name: 'Lid', identifyIds: [] }
    ])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readBridgeLibraryThreeMfIndex back-fills plate filaments from model-settings extruders for unsliced 3MFs', async () => {
  // Unsliced project: no slice_info filament metadata, so plate filaments must be derived from
  // the model_settings object->extruder mapping (via the shared @printstream/shared/three-mf parser).
  // Without this back-fill the library shows no filament chips for freshly uploaded projects.
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-unsliced-filaments-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        '  <object id="3"><metadata key="name" value="Box"/><metadata key="extruder" value="1"/></object>',
        '  <object id="11"><metadata key="name" value="Lid"/><metadata key="extruder" value="2"/></object>',
        '  <plate>',
        '    <metadata key="plater_id" value="1"/>',
        '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
        '    <model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="0"/></model_instance>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        filament_colour: ['#FFFFFF', '#000000'],
        filament_type: ['PLA', 'PLA'],
        filament_settings_id: ['Bambu PLA Basic @White', 'Bambu PLA Basic @Black']
      }), 'utf8')]
    ])

    const index = await readBridgeLibraryThreeMfIndex(sourcePath)

    assert.deepEqual(index.plates[0]?.filaments.map((filament) => filament.id), [1, 2])
    // Names resolve from the project filament map so the library renders filament chips.
    assert.deepEqual(index.plates[0]?.filaments.map((filament) => filament.filamentName), [
      'Bambu PLA Basic @White',
      'Bambu PLA Basic @Black'
    ])
    assert.deepEqual(index.projectFilaments.map((filament) => filament.color), ['#FFFFFF', '#000000'])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readBridgeLibraryThreeMfIndex prefers filament_nozzle_map when non-identity physical mapping conflicts with slice_info group ids', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-nozzle-map-preference-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/slice_info.config', Buffer.from([
        '<config>',
        '  <plate>',
        '    <metadata key="index" value="1"/>',
        '    <filament id="1" type="ABS" color="#FFC72C" group_id="1"/>',
        '    <filament id="2" type="ABS" color="#000000" group_id="0"/>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        filament_colour: ['#FFC72C', '#000000'],
        filament_type: ['ABS', 'ABS'],
        filament_settings_id: ['ABS Left', 'ABS Right'],
        physical_extruder_map: ['1', '0'],
        filament_nozzle_map: ['0', '1'],
        extruder_nozzle_stats: ['tool#1', 'tool#1']
      }), 'utf8')]
    ])

    const index = await readBridgeLibraryThreeMfIndex(sourcePath)

    assert.equal(index.projectFilaments[0]?.nozzleId, 1)
    assert.equal(index.projectFilaments[1]?.nozzleId, 0)
    assert.equal(index.plates[0]?.filaments[0]?.nozzleId, 1)
    assert.equal(index.plates[0]?.filaments[1]?.nozzleId, 0)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readBridgeLibraryThreeMfIndex normalizes identity dual-nozzle project targets to printer nozzle ids', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-nozzle-map-identity-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/slice_info.config', Buffer.from([
        '<config>',
        '  <plate>',
        '    <metadata key="index" value="1"/>',
        '    <filament id="1" type="ABS" color="#FFC72C" group_id="0"/>',
        '    <filament id="2" type="ABS" color="#789D4A" group_id="1"/>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        filament_colour: ['#FFC72C', '#789D4A'],
        filament_type: ['ABS', 'ABS'],
        filament_settings_id: ['ABS Left', 'ABS Right'],
        physical_extruder_map: ['0', '1'],
        filament_nozzle_map: ['0', '1'],
        extruder_nozzle_stats: ['tool#1', 'tool#1']
      }), 'utf8')]
    ])

    const index = await readBridgeLibraryThreeMfIndex(sourcePath)

    assert.equal(index.projectFilaments[0]?.nozzleId, 1)
    assert.equal(index.projectFilaments[1]?.nozzleId, 0)
    assert.equal(index.plates[0]?.filaments[0]?.nozzleId, 1)
    assert.equal(index.plates[0]?.filaments[1]?.nozzleId, 0)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readBridgeLibraryThreeMfIndex treats filament_nozzle_map as final nozzle ids when slice_info has no filament assignments', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-no-filament-slice-info-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/slice_info.config', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><config><header /></config>', 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        filament_colour: ['#FFC72C', '#789D4A', '#FFFFFF'],
        filament_type: ['ABS', 'ABS', 'ABS'],
        filament_settings_id: ['Bambu ABS', 'Bambu ABS', 'Bambu Support for ABS'],
        physical_extruder_map: ['1', '0'],
        filament_nozzle_map: ['1', '0', '0'],
        extruder_nozzle_stats: ['Standard#1', 'Standard#1']
      }), 'utf8')]
    ])

    const index = await readBridgeLibraryThreeMfIndex(sourcePath)

    assert.equal(index.projectFilaments[0]?.nozzleId, 1)
    assert.equal(index.projectFilaments[1]?.nozzleId, 0)
    assert.equal(index.projectFilaments[2]?.nozzleId, 0)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readBridgeLibraryThreeMfIndex prefers concrete slice_info filament usage over conflicting filament_nozzle_map', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-sliced-nozzle-map-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/slice_info.config', Buffer.from([
        '<config>',
        '  <plate>',
        '    <metadata key="index" value="1"/>',
        '    <filament id="1" tray_info_idx="GFB00" type="ABS" color="#FFC72C" used_m="50.12" used_g="125.38" group_id="0" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true" used_for_support="false"/>',
        '    <filament id="2" tray_info_idx="GFB00" type="ABS" color="#789D4A" used_m="0.37" used_g="0.92" group_id="1" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true" used_for_support="false"/>',
        '    <filament id="3" tray_info_idx="GFS06" type="ABS-S" color="#FFFFFF" used_m="2.10" used_g="5.86" group_id="1" nozzle_diameter="0.40" volume_type="Standard" used_for_object="false" used_for_support="true"/>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        filament_colour: ['#FFC72C', '#789D4A', '#FFFFFF'],
        filament_type: ['ABS', 'ABS', 'ABS'],
        filament_settings_id: ['Bambu ABS', 'Bambu ABS', 'Bambu Support for ABS'],
        physical_extruder_map: ['1', '0'],
        filament_nozzle_map: ['1', '0', '0'],
        extruder_nozzle_stats: ['Standard#1', 'Standard#1']
      }), 'utf8')]
    ])

    const index = await readBridgeLibraryThreeMfIndex(sourcePath)

    assert.equal(index.projectFilaments[0]?.nozzleId, 1)
    assert.equal(index.projectFilaments[1]?.nozzleId, 0)
    assert.equal(index.projectFilaments[2]?.nozzleId, 0)
    assert.equal(index.plates[0]?.filaments[0]?.nozzleId, 1)
    assert.equal(index.plates[0]?.filaments[1]?.nozzleId, 0)
    assert.equal(index.plates[0]?.filaments[2]?.nozzleId, 0)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('createSinglePlateBridgeThreeMf strips bulk 3D payload while keeping the selected plate gcode', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-three-mf-test-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'plate-2.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['[Content_Types].xml', Buffer.from('<Types/>', 'utf8')],
      ['_rels/.rels', Buffer.from('<Relationships/>', 'utf8')],
      ['3D/3dmodel.model', Buffer.concat([Buffer.from('<model>', 'utf8'), randomBytes(256 * 1024), Buffer.from('</model>', 'utf8')])],
      ['3D/Textures/huge.texture', randomBytes(128 * 1024)],
      ['Metadata/slice_info.config', Buffer.from([
        '<config>',
        '  <plate><metadata key="index" value="1"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/></plate>',
        '  <plate><metadata key="index" value="2"/><metadata key="gcode_file" value="Metadata/plate_2.gcode"/></plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        '  <plate><metadata key="plater_id" value="1"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/></plate>',
        '  <plate><metadata key="plater_id" value="2"/><metadata key="gcode_file" value="Metadata/plate_2.gcode"/></plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/plate_1.gcode.md5', Buffer.from('md5-plate-one', 'utf8')],
      ['Metadata/plate_2.gcode.md5', Buffer.from('md5-plate-two', 'utf8')],
      ['Metadata/plate_1.gcode', Buffer.from('plate-one', 'utf8')],
      ['Metadata/plate_2.gcode', Buffer.from('plate-two', 'utf8')]
    ])

    await createSinglePlateBridgeThreeMf(sourcePath, outputPath, 2)

    const sourceSize = (await stat(sourcePath)).size
    const outputSize = (await stat(outputPath)).size
    assert.ok(outputSize < sourceSize / 4, `expected slim 3MF to be much smaller than source (${outputSize} vs ${sourceSize})`)
    assert.equal((await readZipEntry(outputPath, 'Metadata/plate_2.gcode')).toString('utf8'), 'plate-two')
    await assert.rejects(() => readZipEntry(outputPath, 'Metadata/plate_1.gcode'))
    await assert.rejects(() => readZipEntry(outputPath, '3D/Textures/huge.texture'))
    assert.match((await readZipEntry(outputPath, '3D/3dmodel.model')).toString('utf8'), /<build\/>/)
    const filteredSliceInfo = (await readZipEntry(outputPath, 'Metadata/slice_info.config')).toString('utf8')
    assert.match(filteredSliceInfo, /value="2"/)
    assert.doesNotMatch(filteredSliceInfo, /value="1"/)
    const filteredModelSettings = (await readZipEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    assert.match(filteredModelSettings, /value="2"/)
    assert.doesNotMatch(filteredModelSettings, /value="1"/)
    assert.equal((await readZipEntry(outputPath, 'Metadata/plate_2.gcode.md5')).toString('utf8'), 'md5-plate-two')
    await assert.rejects(() => readZipEntry(outputPath, 'Metadata/plate_1.gcode.md5'))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readBridgeLibraryThreeMfIndex distinguishes A1 mini from A1 (mini must not classify as A1)', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-a1-mini-'))
  try {
    for (const [model, expected] of [['Bambu Lab A1 mini', 'A1mini'], ['Bambu Lab A1', 'A1']] as const) {
      const sourcePath = path.join(tempDir, `${expected}.3mf`)
      await writeZipFixture(sourcePath, [
        ['Metadata/project_settings.config', Buffer.from(JSON.stringify({ printer_model: [model] }))]
      ])
      const index = await readBridgeLibraryThreeMfIndex(sourcePath)
      // "Bambu Lab A1 mini" contains " A1 ", which used to short-circuit to A1 — making the
      // slice dialog pair A1 filament profiles with the project's A1-mini machine profile.
      assert.deepEqual(index.compatiblePrinterModels, [expected])
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

async function writeZipFixture(filePath: string, entries: Array<[string, Buffer]>): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const [entryPath, buffer] of entries) {
    zip.addBuffer(buffer, entryPath)
  }

  await new Promise<void>((resolve, reject) => {
    zip.outputStream
      .pipe(createWriteStream(filePath))
      .on('close', resolve)
      .on('error', reject)
    zip.end()
  })
}

function readZipEntry(filePath: string, entryPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open zip'))
        return
      }

      let settled = false
      const finish = (error: Error | null, value?: Buffer) => {
        if (settled) return
        settled = true
        zipFile.close()
        if (error) reject(error)
        else resolve(value ?? Buffer.alloc(0))
      }

      zipFile.on('error', (error) => finish(error))
      zipFile.on('end', () => finish(new Error(`Entry not found: ${entryPath}`)))
      zipFile.on('entry', (entry: Entry) => {
        if (entry.fileName !== entryPath) {
          zipFile.readEntry()
          return
        }

        readZipEntryBuffer(zipFile, entry).then(
          (buffer) => finish(null, buffer),
          (error) => finish(error)
        )
      })
      zipFile.readEntry()
    })
  })
}

function readZipEntryBuffer(zipFile: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('Failed to open entry stream'))
        return
      }

      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
  })
}