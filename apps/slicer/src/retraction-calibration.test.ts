import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isRetractionCalibration, rewriteRetractionCalibration } from './retraction-calibration.js'
import { readZipEntryText, writeZip } from './zip-io.js'

test('packaged retraction updates the checksum and preserves other entries; unsupported output stays intact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'retraction-package-'))
  const file = path.join(directory, 'slice.3mf')
  try {
    const gcode = 'M83\n; PRINTSTREAM_RETRACTION_LENGTH=0.2\nG1 E-.8 F1800\nG1 X10 Y10\nG1 E.8 F1800\n; PRINTSTREAM_RETRACTION_END\n'
    await writeZip(file, [
      { name: 'Metadata/plate_1.gcode', buffer: Buffer.from(gcode) },
      { name: 'Metadata/plate_1.gcode.md5', buffer: Buffer.from('old') },
      { name: 'Metadata/printstream_retraction_calibration.json', buffer: Buffer.from('{"version":1}') },
      { name: 'unrelated.txt', buffer: Buffer.from('preserved') }
    ])
    assert.equal(await isRetractionCalibration(file), true)
    await rewriteRetractionCalibration(file)
    const rewritten = await readZipEntryText(file, 'Metadata/plate_1.gcode')
    assert.match(rewritten, /G1 E-0.2 F1800/)
    assert.match(rewritten, /G1 E0.2 F1800/)
    assert.equal(await readZipEntryText(file, 'Metadata/plate_1.gcode.md5'), createHash('md5').update(rewritten).digest('hex'))
    assert.equal(await readZipEntryText(file, 'unrelated.txt'), 'preserved')

    await writeZip(file, [{ name: 'Metadata/plate_1.gcode', buffer: Buffer.from('M82\n' + gcode.replace('M83\n', '')) }])
    const original = await readFile(file)
    assert.equal(await isRetractionCalibration(file), false)
    await assert.rejects(rewriteRetractionCalibration(file), /relative/)
    assert.deepEqual(await readFile(file), original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
