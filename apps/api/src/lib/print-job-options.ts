/**
 * The codec for `PrintJob.printOptionsJson`: what a print was started with, and how a
 * re-print gets it back.
 *
 * Owns BOTH directions in one module on purpose. The jobs DTO (what the print dialog
 * restores from) and `reprintJobFromRow` (what an override-less `POST /jobs/:id/reprint`
 * dispatches) both ask this module what a row recorded. When they each derived it, they
 * disagreed: the API guessed `'on'` while the browser used its own remembered preference, so
 * a print could come back one way through the dialog and another way through the API.
 *
 * Contract: `readRecordedPrintStartOptions` returns only what is actually KNOWN about a row,
 * so a caller can tell "recorded as off" from "never recorded" and fall back for itself
 * (the schema default on the API side, the remembered preference in the dialog). It never
 * invents a value to fill the gap; inventing one is what issue #97 was.
 */
import { printStartOptionSelectionSchema } from '@printstream/shared'
import type { PrintStartOptionSelection } from '@printstream/shared'

/**
 * What a `PrintJob` row records about its print-start options. A field is ABSENT when the
 * row never captured it, which is not the same as a field recorded at its default value.
 */
export type RecordedPrintStartOptions = Partial<PrintStartOptionSelection>

/**
 * The subset of a `PrintJob` row this module reads. Both columns are optional so the legacy
 * jobs query (a raw SQL fallback that selects neither) still satisfies it.
 */
export interface RecordedPrintStartOptionsRow {
  printOptionsJson?: string | null
  /** Legacy tri-state-collapsed-to-Boolean bed leveling. See {@link readRecordedPrintStartOptions}. */
  bedLevel?: boolean | null
}

/**
 * Serialize the user's selection for storage. Takes the SELECTION, never the values
 * `normalizePrintStartOptionsForPrinter` produced: that function clamps to the target
 * printer (`'auto'` -> `'on'` where auto is unsupported) and overwrites
 * `vibrationCompensation`/`filamentDynamicsCalibration` with the Studio defaults outright,
 * so recording its output would store choices the user never made and would re-break Auto
 * the moment a re-print retargets a printer that does support it.
 *
 * Returns null for a missing selection so the column stays null rather than holding `"null"`.
 */
export function serializeRecordedPrintStartOptions(
  options: PrintStartOptionSelection | null | undefined
): string | null {
  return options ? JSON.stringify(printStartOptionSelectionSchema.parse(options)) : null
}

/**
 * Read back what a row knows about how its print was started, or null when it knows nothing.
 *
 * Two sources, newest first:
 *
 * 1. `printOptionsJson`: the full selection. Unparseable or schema-invalid JSON is treated
 *    as absent rather than throwing: a re-print falling back is far better than a history
 *    page that 500s on one bad row.
 * 2. The legacy `bedLevel` Boolean, for rows written before the column existed. Only
 *    `false` survives that conversion, and this is the subtle part: `false` means the user
 *    definitely chose Off, but `true` was written by `bedLevel !== 'off'` and so means
 *    "On OR Auto" with no way to tell which. Reporting the ambiguous case as `'on'` is
 *    exactly the guess that made re-printing an Auto job come back as On, so it is reported
 *    as UNKNOWN and the caller's own fallback applies. That costs nothing on the API path
 *    (`printFromLibrarySchema` already defaults `bedLevel` to `'on'`, so an override-less
 *    re-print of a legacy row dispatches identically to before) and gains the dialog the
 *    ability to reach Auto again.
 */
export function readRecordedPrintStartOptions(
  row: RecordedPrintStartOptionsRow
): RecordedPrintStartOptions | null {
  const recorded = parseRecordedPrintStartOptions(row.printOptionsJson)
  if (recorded) return recorded
  return row.bedLevel === false ? { bedLevel: 'off' } : null
}

function parseRecordedPrintStartOptions(json: string | null | undefined): RecordedPrintStartOptions | null {
  if (!json) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return warnUnreadableRecordedOptions('invalid JSON')
  }
  const parsed = printStartOptionSelectionSchema.safeParse(raw)
  return parsed.success ? parsed.data : warnUnreadableRecordedOptions(parsed.error.issues[0]?.message ?? 'schema mismatch')
}

/**
 * A row we wrote ourselves from a validated selection should always read back, so a failure
 * here is either a corrupted column or an incompatible change to
 * `printStartOptionSelectionSchema`, and the latter would silently un-fix issue #97 for every
 * row already recorded. Degrading to "unknown" is still the right RUNTIME behavior (a re-print
 * that falls back beats a history page that 500s on one bad row), so this logs and continues.
 * Safe to log: the column holds print-start enums, never a secret.
 */
function warnUnreadableRecordedOptions(reason: string): null {
  console.warn(`[print-job-options] ignoring unreadable PrintJob.printOptionsJson: ${reason}`)
  return null
}
