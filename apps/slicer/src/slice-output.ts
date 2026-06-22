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
