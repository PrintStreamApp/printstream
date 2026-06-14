import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import yazl from 'yazl'
import {
  buildCoverThumbnailCandidates,
  chooseCoverThumbnailFileHint,
  choosePreferredCoverFileHint,
  isDirectArchiveCoverHint,
  readCoverFromArchive
} from './cover-thumbnail.js'

async function createFixtureArchive(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bambu-cover-thumbnail-'))
  const filePath = path.join(dir, 'fixture.3mf')
  const zip = new yazl.ZipFile()

  zip.addBuffer(Buffer.from([
    '<config>',
    '  <plate>',
    '    <metadata key="index" value="1"/>',
    '    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>',
    '    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>',
    '  </plate>',
    '  <plate>',
    '    <metadata key="index" value="2"/>',
    '    <metadata key="gcode_file" value="Metadata/plate_2.gcode"/>',
    '    <metadata key="thumbnail_file" value="Metadata/plate_2.png"/>',
    '  </plate>',
    '</config>'
  ].join('\n'), 'utf8'), 'Metadata/slice_info.config')
  zip.addBuffer(Buffer.from('plate-one', 'utf8'), 'Metadata/plate_1.png')
  zip.addBuffer(Buffer.from('plate-two', 'utf8'), 'Metadata/plate_2.png')

  await new Promise<void>((resolve, reject) => {
    zip.outputStream
      .pipe(createWriteStream(filePath))
      .on('close', resolve)
      .on('error', reject)
    zip.end()
  })

  return filePath
}

test('readCoverFromArchive selects the thumbnail matching the active plate gcode file', async () => {
  const filePath = await createFixtureArchive()
  try {
    const png = await readCoverFromArchive(filePath, 'Metadata/plate_2.gcode')
    assert.equal(png.toString('utf8'), 'plate-two')
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true })
  }
})

test('buildCoverThumbnailCandidates prefers the requested plate before first-plate fallback', () => {
  const candidates = buildCoverThumbnailCandidates({
    plates: [
      { index: 1, thumbnailFile: 'Metadata/plate_1.png' },
      { index: 2, thumbnailFile: 'Metadata/plate_2.png' }
    ]
  } as never, 2)

  assert.deepEqual(candidates, ['Metadata/plate_2.png', 'Metadata/plate_1.png', 'Metadata/top_1.png'])
})

test('choosePreferredCoverFileHint prefers a direct archive filename over metadata plate paths', () => {
  assert.equal(
    choosePreferredCoverFileHint('/data/Metadata/plate_3.gcode', 'CSM - Bambu - 3 - Gears_ Cam knobs.gcode.3mf'),
    'CSM - Bambu - 3 - Gears_ Cam knobs.gcode.3mf'
  )
  assert.equal(isDirectArchiveCoverHint('/data/Metadata/plate_3.gcode'), false)
  assert.equal(isDirectArchiveCoverHint('CSM - Bambu - 3 - Gears_ Cam knobs.gcode.3mf'), true)
})

test('chooseCoverThumbnailFileHint prefers the selected plate over an archive source hint', () => {
  assert.equal(
    chooseCoverThumbnailFileHint('Cylinders - Single 54 Needle.gcode.3mf', 'Metadata/plate_23.gcode'),
    'Metadata/plate_23.gcode'
  )
})