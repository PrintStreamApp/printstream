/**
 * Calibration-only packaged output rewrite. The source project's versioned
 * marker opts in; ordinary slices never read or rewrite their toolpaths here.
 * Recomputes Bambu's G-code MD5 sidecar and atomically replaces the package.
 * Counterpart: api/plugins/calibration/build-3mf.ts authors the marker and bands.
 */
import { createHash } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { readAllZipEntries, readZipEntryText, writeZip } from './zip-io.js'
import { applyRetractionCalibration } from './retraction-calibration-gcode.js'

const MARKER = 'Metadata/printstream_retraction_calibration.json'

/** Reject invalid opt-in metadata; absence alone means an ordinary slice. */
export async function isRetractionCalibration(inputPath: string): Promise<boolean> {
  let text: string
  try {
    text = await readZipEntryText(inputPath, MARKER)
  } catch (error) {
    if (error instanceof Error && error.message === `Entry not found: ${MARKER}`) return false
    throw error
  }
  if (JSON.parse(text).version !== 1) throw new Error('Unsupported retraction calibration version')
  return true
}

/** Run before usage extraction or plain-G-code export, so every downstream consumer sees the tested toolpath. */
export async function rewriteRetractionCalibration(outputPath: string): Promise<void> {
  const entries = await readAllZipEntries(outputPath)
  const toolpaths = entries.filter((entry) => /^Metadata\/plate_\d+\.gcode$/.test(entry.name))
  if (toolpaths.length !== 1) throw new Error('Retraction calibration requires one sliced plate')
  const toolpath = toolpaths[0]!
  const result = applyRetractionCalibration(toolpath.buffer.toString('utf8'))
  if (!result.pairs) throw new Error('The slicer did not preserve the retraction calibration bands')
  toolpath.buffer = Buffer.from(result.gcode)
  const checksumName = `${toolpath.name}.md5`
  const checksum = Buffer.from(createHash('md5').update(toolpath.buffer).digest('hex'))
  const existing = entries.find((entry) => entry.name === checksumName)
  if (existing) existing.buffer = checksum
  else entries.push({ name: checksumName, buffer: checksum, mtime: toolpath.mtime })
  const temporary = `${outputPath}.retraction`
  try {
    await writeZip(temporary, entries)
    await rename(temporary, outputPath)
  } finally {
    await rm(temporary, { force: true })
  }
}
