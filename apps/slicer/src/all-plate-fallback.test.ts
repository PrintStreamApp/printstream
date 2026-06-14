import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import yauzl from 'yauzl'
import yazl from 'yazl'
import {
  backfillPlateThumbnails,
  buildModelSettingsRelationshipsXml,
  extractPlateIdsFromModelSettingsXml,
  mergeAllPlateOutputs,
  mergeModelSettingsXml,
  mergeSliceInfoXml,
  shouldUseAllPlateMergeFallback
} from './all-plate-fallback.js'

test('shouldUseAllPlateMergeFallback only triggers for non-H2D all-plate packaged outputs', () => {
  assert.equal(shouldUseAllPlateMergeFallback({ plate: 0, outputFileName: 'job.gcode.3mf', printerModel: 'P1S' }), true)
  assert.equal(shouldUseAllPlateMergeFallback({ plate: 0, outputFileName: 'job.gcode.3mf', printerModel: 'H2D' }), false)
  assert.equal(shouldUseAllPlateMergeFallback({ plate: 1, outputFileName: 'job.gcode.3mf', printerModel: 'P1S' }), false)
  assert.equal(shouldUseAllPlateMergeFallback({ plate: 0, outputFileName: 'job.gcode', printerModel: 'P1S' }), false)
})

test('extractPlateIdsFromModelSettingsXml returns ordered plate ids', () => {
  const xml = `
    <config>
      <plate><metadata key="plater_id" value="2"/></plate>
      <plate><metadata key="plater_id" value="1"/></plate>
    </config>
  `
  assert.deepEqual(extractPlateIdsFromModelSettingsXml(xml), [1, 2])
})

test('mergeSliceInfoXml replaces placeholder plates with per-plate blocks', () => {
  const merged = mergeSliceInfoXml(
    '<config>\n  <header/>\n  <plate><metadata key="index" value="1"/></plate>\n</config>',
    new Map([
      [1, '<plate><metadata key="index" value="1"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/></plate>'],
      [2, '<plate><metadata key="index" value="2"/><metadata key="gcode_file" value="Metadata/plate_2.gcode"/></plate>']
    ])
  )

  assert.match(merged, /index" value="1"[\s\S]*plate_1\.gcode/)
  assert.match(merged, /index" value="2"[\s\S]*plate_2\.gcode/)
})

test('mergeModelSettingsXml replaces matching plate blocks', () => {
  const merged = mergeModelSettingsXml(
    '<config>\n  <plate><metadata key="plater_id" value="1"/><metadata key="gcode_file" value=""/></plate>\n  <plate><metadata key="plater_id" value="2"/><metadata key="gcode_file" value=""/></plate>\n</config>',
    new Map([
      [2, '<plate><metadata key="plater_id" value="2"/><metadata key="gcode_file" value="Metadata/plate_2.gcode"/></plate>']
    ])
  )

  assert.match(merged, /plater_id" value="2"[\s\S]*plate_2\.gcode/)
})

test('buildModelSettingsRelationshipsXml includes each plate gcode', () => {
  const xml = buildModelSettingsRelationshipsXml([1, 2])
  assert.match(xml, /Target="\/Metadata\/plate_1\.gcode"/)
  assert.match(xml, /Target="\/Metadata\/plate_2\.gcode"/)
})

test('mergeAllPlateOutputs combines per-plate packaged outputs into one multi-plate artifact', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'printstream-all-plate-'))
  const plate1Path = path.join(tempDir, 'plate-1.gcode.3mf')
  const plate2Path = path.join(tempDir, 'plate-2.gcode.3mf')
  const mergedPath = path.join(tempDir, 'merged.gcode.3mf')

  await writeZip(plate1Path, {
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    'Metadata/slice_info.config': '<?xml version="1.0" encoding="UTF-8"?><config><plate><metadata key="index" value="1"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/></plate></config>',
    'Metadata/model_settings.config': '<?xml version="1.0" encoding="UTF-8"?><config><plate><metadata key="plater_id" value="1"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/></plate><plate><metadata key="plater_id" value="2"/><metadata key="gcode_file" value=""/></plate></config>',
    'Metadata/_rels/model_settings.config.rels': '<Relationships><Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/></Relationships>',
    'Metadata/project_settings.config': '{}',
    'Metadata/plate_1.gcode': 'plate one',
    'Metadata/plate_1.png': 'png1',
    'Metadata/pick_1.png': 'pick1',
    'Metadata/top_1.png': 'top1'
  })
  await writeZip(plate2Path, {
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    'Metadata/slice_info.config': '<?xml version="1.0" encoding="UTF-8"?><config><plate><metadata key="index" value="2"/><metadata key="gcode_file" value="Metadata/plate_2.gcode"/></plate></config>',
    'Metadata/model_settings.config': '<?xml version="1.0" encoding="UTF-8"?><config><plate><metadata key="plater_id" value="1"/><metadata key="gcode_file" value=""/></plate><plate><metadata key="plater_id" value="2"/><metadata key="gcode_file" value="Metadata/plate_2.gcode"/></plate></config>',
    'Metadata/_rels/model_settings.config.rels': '<Relationships><Relationship Target="/Metadata/plate_2.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/></Relationships>',
    'Metadata/project_settings.config': '{}',
    'Metadata/plate_2.gcode': 'plate two',
    'Metadata/plate_2.png': 'png2',
    'Metadata/pick_2.png': 'pick2',
    'Metadata/top_2.png': 'top2'
  })

  await mergeAllPlateOutputs({
    outputPath: mergedPath,
    plateOutputs: [
      { plate: 1, filePath: plate1Path },
      { plate: 2, filePath: plate2Path }
    ]
  })

  const mergedSliceInfo = await readZipEntryText(mergedPath, 'Metadata/slice_info.config')
  const mergedModelSettings = await readZipEntryText(mergedPath, 'Metadata/model_settings.config')
  const mergedRelationships = await readZipEntryText(mergedPath, 'Metadata/_rels/model_settings.config.rels')
  const plateTwoGcode = await readZipEntryText(mergedPath, 'Metadata/plate_2.gcode')

  assert.match(mergedSliceInfo, /index" value="1"/)
  assert.match(mergedSliceInfo, /index" value="2"/)
  assert.match(mergedModelSettings, /plater_id" value="2"[\s\S]*plate_2\.gcode/)
  assert.match(mergedRelationships, /plate_1\.gcode/)
  assert.match(mergedRelationships, /plate_2\.gcode/)
  assert.equal(plateTwoGcode, 'plate two')
})

test('backfillPlateThumbnails copies missing plate PNGs from the input, preserving existing entries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'backfill-thumbs-'))
  const outputPath = path.join(dir, 'out.gcode.3mf')
  const inputPath = path.join(dir, 'in.3mf')
  // Output has two plates of gcode but no thumbnails (the all-plate export bug).
  await writeZip(outputPath, {
    'Metadata/plate_1.gcode': 'G1 X1',
    'Metadata/plate_2.gcode': 'G1 X2',
    'Metadata/slice_info.config': '<config/>'
  })
  // Input (the source/arranged project) carries the model renders.
  await writeZip(inputPath, {
    'Metadata/plate_1.png': 'PNG-1',
    'Metadata/plate_1_small.png': 'PNG-1S',
    'Metadata/plate_2.png': 'PNG-2',
    'Metadata/plate_2_small.png': 'PNG-2S',
    'Metadata/plate_9.png': 'PNG-9-unused'
  })

  await backfillPlateThumbnails(outputPath, inputPath)

  assert.equal(await readZipEntryText(outputPath, 'Metadata/plate_1.png'), 'PNG-1')
  assert.equal(await readZipEntryText(outputPath, 'Metadata/plate_2.png'), 'PNG-2')
  assert.equal(await readZipEntryText(outputPath, 'Metadata/plate_1_small.png'), 'PNG-1S')
  // Existing gcode is preserved; thumbnails for plates without gcode aren't pulled in.
  assert.equal(await readZipEntryText(outputPath, 'Metadata/plate_1.gcode'), 'G1 X1')
  await assert.rejects(readZipEntryText(outputPath, 'Metadata/plate_9.png'))
})

test('backfillPlateThumbnails leaves the output untouched when thumbnails already exist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'backfill-noop-'))
  const outputPath = path.join(dir, 'out.gcode.3mf')
  const inputPath = path.join(dir, 'in.3mf')
  await writeZip(outputPath, {
    'Metadata/plate_1.gcode': 'G1 X1',
    'Metadata/plate_1.png': 'ALREADY',
    'Metadata/plate_1_small.png': 'ALREADY-S'
  })
  await writeZip(inputPath, { 'Metadata/plate_1.png': 'FROM-INPUT', 'Metadata/plate_1_small.png': 'FROM-INPUT-S' })

  await backfillPlateThumbnails(outputPath, inputPath)

  // The already-present render is kept (not overwritten by the input's).
  assert.equal(await readZipEntryText(outputPath, 'Metadata/plate_1.png'), 'ALREADY')
})

async function writeZip(filePath: string, entries: Record<string, string>): Promise<void> {
  const zipFile = new yazl.ZipFile()
  for (const [name, content] of Object.entries(entries)) {
    zipFile.addBuffer(Buffer.from(content, 'utf8'), name)
  }
  await new Promise<void>((resolve, reject) => {
    zipFile.outputStream
      .pipe(createWriteStream(filePath))
      .on('finish', resolve)
      .on('error', reject)
    zipFile.end()
  })
}

async function readZipEntryText(filePath: string, entryName: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('Failed to open zip'))
        return
      }
      let settled = false
      const finish = (caught?: Error, value?: string) => {
        if (settled) return
        settled = true
        zipFile.close()
        if (caught) reject(caught)
        else resolve(value ?? '')
      }
      zipFile.on('error', finish)
      zipFile.on('end', () => finish(new Error(`Entry not found: ${entryName}`)))
      zipFile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipFile.readEntry()
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`Failed to read ${entryName}`))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('error', finish)
          stream.on('end', () => finish(undefined, Buffer.concat(chunks).toString('utf8')))
        })
      })
      zipFile.readEntry()
    })
  })
}