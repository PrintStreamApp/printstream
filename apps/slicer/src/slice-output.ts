/**
 * Bounded slicing-output buffers.
 *
 * The CLI is run with verbose flags (`--debug 2`), so its stdout/stderr can be
 * enormous. These helpers keep the per-job structured line buffer and the raw
 * combined strings bounded so a long or pathological slice can't grow the slicer's
 * memory (or, downstream, the API's persisted output) without limit. Kept out of
 * index.ts (which boots the HTTP server on import) so they stay unit-testable.
 */
import type { SlicingOutputLine } from '@printstream/shared'

/** Hard cap on retained structured output lines, with a low-water mark to trim to. */
const MAX_OUTPUT_LINES_HEADER_BYTES = 8 * 1024

const MAX_OUTPUT_LINES = 5_000
const OUTPUT_LINES_TRIM_TO = 4_000

/** Cap on each retained raw combined stdout/stderr string (keeps the most recent tail). */
export const MAX_COMBINED_OUTPUT_BYTES = 256 * 1024

export function appendOutput(outputLines: SlicingOutputLine[], stream: 'stdout' | 'stderr', chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    const text = line.trimEnd()
    if (!text) continue
    appendStructuredOutput(outputLines, stream, text)
  }
}

/**
 * A `'system'` line is NOT a log line: the web renders the newest one verbatim as the job's
 * status (`formatSlicingProgress` in `apps/web/src/lib/slicingJobPresentation.ts`). Write those
 * as user-facing copy, no internal nouns, no pipeline mechanics. `stdout`/`stderr` lines are the
 * engine's own and are only mined for its JSON progress frames.
 */
export function appendStructuredOutput(outputLines: SlicingOutputLine[], stream: SlicingOutputLine['stream'], text: string): void {
  outputLines.push({ stream, text, createdAt: new Date().toISOString() })
  // Drop the oldest lines in batches once the cap is exceeded (amortized O(1));
  // the consumers only ever read the tail (latest system lines / last N).
  if (outputLines.length > MAX_OUTPUT_LINES) {
    outputLines.splice(0, outputLines.length - OUTPUT_LINES_TRIM_TO)
  }
}

/** Append a chunk to a raw combined buffer, keeping only the most recent `maxBytes`. */
export function appendCappedTail(current: string, chunk: string, maxBytes: number = MAX_COMBINED_OUTPUT_BYTES): string {
  const next = current + chunk
  return next.length > maxBytes ? next.slice(next.length - maxBytes) : next
}

/** Encode a bounded progress summary for the binary slice response header. */
export function buildOutputLinesHeader(outputLines: SlicingOutputLine[]): string {
  const latestSystemLines = outputLines.filter((line) => line.stream === 'system').slice(-20)
  const fallbackLines = outputLines.slice(-8)
  const candidateLines = latestSystemLines.length > 0 ? latestSystemLines : fallbackLines
  const compactLines = candidateLines.map((line) => ({
    stream: line.stream,
    text: line.text.slice(0, 240),
    createdAt: line.createdAt
  }))

  let selected = compactLines.slice()
  let encoded = encodeOutputLines(selected)
  while (selected.length > 1 && Buffer.byteLength(encoded, 'utf8') > MAX_OUTPUT_LINES_HEADER_BYTES) {
    selected = selected.slice(Math.ceil(selected.length / 2))
    encoded = encodeOutputLines(selected)
  }

  return encoded
}

function encodeOutputLines(lines: Array<Pick<SlicingOutputLine, 'stream' | 'text' | 'createdAt'>>): string {
  return Buffer.from(JSON.stringify(lines), 'utf8').toString('base64url')
}
