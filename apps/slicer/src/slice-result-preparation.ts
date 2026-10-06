/**
 * Prepare a completed CLI result for the HTTP response.
 *
 * Legacy packages may need metadata repair, missing plate thumbnails, or plain G-code extraction.
 * Read package usage before extraction, then validate the final bytes and merge engine timing.
 * The slice route owns the response stream and disconnect cleanup.
 */
import { stat } from 'node:fs/promises'
import { isDirectPrintableFileName, type SlicingMetadata } from '@printstream/shared'
import { backfillPlateThumbnails } from './all-plate-fallback.js'
import { readSlicedOutputTiming } from './gcode-header.js'
import { type SlicedArtifactMetadata } from './output-metadata.js'
import { rewriteRetractionCalibration } from './retraction-calibration.js'
import { tryReadSlicingMetadata } from './slice-result-metadata.js'
import { extractGcodeFromPackagedOutput, normalizeCliOutput } from './slice-output-files.js'
import { mergeSlicedOutputTiming, mergeSlicedOutputUsage, parseSlicedOutputUsage } from './sliced-output-usage.js'
import { readZipEntryText } from './zip-io.js'

export class SliceOutputLimitError extends Error {
  constructor() {
    super('Slicer output exceeds the configured size limit.')
  }
}

/** Return final file size and metadata after all format-specific output work has completed. */
export async function prepareSlicedResult(input: {
  outputPath: string
  outputDir: string
  outputFileName: string
  originalInputPath: string
  retractionCalibration: boolean
  metadata: SlicedArtifactMetadata | null
  maxOutputBytes: number
}): Promise<{ size: number; metadata: SlicingMetadata }> {
  await normalizeCliOutput({
    outputPath: input.outputPath,
    outputDir: input.outputDir,
    outputFileName: input.outputFileName,
    metadata: input.metadata
  })

  // The CLI can skip plate thumbnails when GL is unavailable. The original project retains
  // the previews that a legacy prepared copy may have stripped.
  if (input.outputFileName.toLowerCase().endsWith('.3mf')) {
    await backfillPlateThumbnails(input.outputPath, input.originalInputPath)
  }

  if (input.retractionCalibration) {
    await rewriteRetractionCalibration(input.outputPath)
  }

  // Plain G-code extraction discards slice_info.config, so collect its material usage first.
  const packagedUsage = await readZipEntryText(input.outputPath, 'Metadata/slice_info.config')
    .then(parseSlicedOutputUsage)
    .catch(() => null)
  if (input.outputFileName.toLowerCase().endsWith('.gcode')) {
    const extracted = await extractGcodeFromPackagedOutput(input.outputPath)
    if (!extracted) {
      throw new Error('Requested .gcode output, but slicer did not produce a plain gcode payload')
    }
  }

  const info = await stat(input.outputPath)
  if (!info.isFile() || info.size <= 0) throw new Error('Slicer did not produce an output file')
  if (info.size > input.maxOutputBytes) throw new SliceOutputLimitError()
  if (!isDirectPrintableFileName(input.outputFileName)) throw new Error('Slicer output must be .gcode or .gcode.3mf')

  const metadata = mergeSlicedOutputTiming(
    mergeSlicedOutputUsage(await tryReadSlicingMetadata(input.outputDir, input.outputFileName), packagedUsage),
    await readSlicedOutputTiming(input.outputPath)
  )
  return { size: info.size, metadata }
}
