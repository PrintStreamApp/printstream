/**
 * Reads the leading bytes of a finished slice's G-code, whether it is plain or packaged in a
 * `.gcode.3mf`, and reads each plate's whole-print and prepare time without inflating
 * the full toolpath. The caller uses plate times to keep an all-plate total consistent.
 *
 * Exists because `result.json` cannot answer it. Its top-level `prepare_time` is a different
 * quantity that merely shares the name: `global_current_time - global_begin_time`
 * (`BambuStudio.cpp:6201`), the CLI's own wall clock in MILLISECONDS from process start to slice
 * start. That measures the container running the slicer, not the printer, and reading it as seconds
 * reported "2h 13m" of prepare on an 8-second load. The engine writes the real figure only into the
 * G-code header, as the difference between its two stated times; the parsing of that line is
 * `@printstream/shared/gcode-header-times`, shared with the web's G-code preview.
 *
 * Everything here is BEST EFFORT and returns null rather than throwing. A slice that produced a
 * printable file must never fail over a missing usage estimate.
 */
import { open } from 'node:fs/promises'
import yauzl from 'yauzl'
import { parseGcodeHeaderTimes } from '@printstream/shared'

export interface SlicedOutputTiming {
  /** Null when even one plate lacks a whole-print estimate. */
  totalSeconds: number | null
  prepareSeconds: number | null
  plates: Array<{ index: number; totalSeconds: number }>
}

/** Read each finished plate's G-code header so an all-plate result can sum real plate times. */
export async function readSlicedOutputTiming(outputPath: string): Promise<SlicedOutputTiming> {
  try {
    const headers = await readGcodeHeaderEntries(outputPath)
    let totalSeconds = 0
    let hasEveryTotal = headers.length > 0
    let prepareSeconds: number | null = null
    const plates: SlicedOutputTiming['plates'] = []

    for (const header of headers) {
      const times = parseGcodeHeaderTimes(header.text)
      if (times.totalSeconds == null) {
        hasEveryTotal = false
      } else {
        totalSeconds += times.totalSeconds
        if (header.plateIndex != null) {
          plates.push({ index: header.plateIndex, totalSeconds: times.totalSeconds })
        }
      }
      if (times.prepareSeconds != null) {
        prepareSeconds = (prepareSeconds ?? 0) + times.prepareSeconds
      }
    }

    return { totalSeconds: hasEveryTotal ? totalSeconds : null, prepareSeconds, plates }
  } catch {
    // Estimates are best effort; an unreadable header cannot invalidate printable output.
    return { totalSeconds: null, prepareSeconds: null, plates: [] }
  }
}

/**
 * Enough to hold BambuStudio's `HEADER_BLOCK`, which carries the time line. Generous: the block is
 * a few hundred bytes, it sits well before the `CONFIG_BLOCK` and the moves, and the cost of
 * reading too little is a silently absent estimate rather than an error.
 */
const GCODE_HEADER_PROBE_BYTES = 16_384

/**
 * The print's prepare phase in seconds, SUMMED across every plate in the output, or null when the
 * output states no such thing.
 *
 * Summed because its sibling is: `estimatedPrintTimeSeconds` adds `total_predication` over every
 * sliced plate, so reporting plate 1's prepare beside all four plates' print time would put two
 * different scopes on one panel. An all-plate export really does heat and level once per plate.
 */
export async function readPrepareTimeSeconds(outputPath: string): Promise<number | null> {
  return (await readSlicedOutputTiming(outputPath)).prepareSeconds
}

/** Every plate's G-code header. One entry for a plain `.gcode`, one per plate for a package. */
export async function readGcodeHeaders(outputPath: string): Promise<string[]> {
  return (await readGcodeHeaderEntries(outputPath)).map((entry) => entry.text)
}

type GcodeHeaderEntry = { plateIndex: number | null; text: string }

async function readGcodeHeaderEntries(outputPath: string): Promise<GcodeHeaderEntry[]> {
  const single = await readGcodeHeader(outputPath)
  if (single != null) return [{ plateIndex: null, text: single }]
  return await readPackagedGcodeHeaders(outputPath)
}

/** A PLAIN `.gcode` output's header, or null when the file is packaged, missing or empty. */
export async function readGcodeHeader(outputPath: string): Promise<string | null> {
  let handle
  try {
    handle = await open(outputPath, 'r')
  } catch {
    return null
  }
  try {
    const probe = Buffer.alloc(GCODE_HEADER_PROBE_BYTES)
    const { bytesRead } = await handle.read(probe, 0, GCODE_HEADER_PROBE_BYTES, 0)
    if (bytesRead <= 0) return null
    // A `.gcode.3mf` is a zip, so its first bytes are `PK`, not G-code. Anything else is already
    // plain G-code: the `.gcode` request path unpacks the payload before this runs.
    if (probe[0] === 0x50 && probe[1] === 0x4b) return null
    return probe.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Every G-code entry's leading bytes, WITHOUT inflating any of them past the probe.
 *
 * A sliced plate is routinely hundreds of megabytes decompressed (640k lines on an ordinary
 * five-hour print) and this runs on every successful slice, so each stream is torn down the moment
 * its probe is full rather than read to completion.
 */
async function readPackagedGcodeHeaders(zipPath: string): Promise<GcodeHeaderEntry[]> {
  return await new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        resolve([])
        return
      }
      const headers: GcodeHeaderEntry[] = []
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        zipFile.close()
        resolve(headers)
      }
      zipFile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName) || !entry.fileName.toLowerCase().endsWith('.gcode')) {
          zipFile.readEntry()
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zipFile.readEntry()
            return
          }
          const chunks: Buffer[] = []
          let length = 0
          let taken = false
          const takeAndContinue = () => {
            if (taken) return
            taken = true
            const plateMatch = /^Metadata\/plate_(\d+)\.gcode$/i.exec(entry.fileName)
            headers.push({
              plateIndex: plateMatch ? Number.parseInt(plateMatch[1]!, 10) : null,
              text: Buffer.concat(chunks).subarray(0, GCODE_HEADER_PROBE_BYTES).toString('utf8')
            })
            zipFile.readEntry()
          }
          stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
            length += chunk.length
            if (length >= GCODE_HEADER_PROBE_BYTES) stream.destroy()
          })
          // A destroyed stream ends with 'close' and never 'end', so both have to move on to the
          // next entry or a large plate stalls the walk forever.
          stream.once('close', takeAndContinue)
          stream.once('end', takeAndContinue)
          stream.once('error', () => {
            if (taken) return
            taken = true
            zipFile.readEntry()
          })
        })
      })
      zipFile.once('end', finish)
      zipFile.once('error', finish)
      zipFile.readEntry()
    })
  })
}
