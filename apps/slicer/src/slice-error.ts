/**
 * Turns BambuStudio CLI slice-time *preset/printer incompatibility* output into a
 * clear, user-facing message.
 *
 * When a filament (or other) preset is not compatible with the target machine,
 * the CLI prints a line like:
 *   `[error]   run 3008: filament preset Bambu PLA Basic @BBL A1 (slot 1) is not compatible with printer Bambu Lab A1 mini 0.4 nozzle.`
 * on **stdout** (not stderr) and exits non-zero ("run found error, return -5" ->
 * process exit code 251). Without this, the failure surfaces only as the opaque
 * "Slicer CLI exited with code 251", which is what made these failures look like
 * "no error" to users. We scan the combined CLI output and lift the CLI's own
 * (already human-readable) reason into the thrown error.
 */
export function formatSlicePresetIncompatibilityError(output: string): string | null {
  if (!output) return null
  for (const rawLine of output.split(/\r?\n/)) {
    // Capture from "<kind> preset ... is not compatible with printer ..." to end of line,
    // dropping the CLI's timestamp/level/"run NNNN:" prefix.
    const match = rawLine.match(/((?:\w+\s+)?preset\b.*?\bis not compatible with printer\b.*)$/i)
    if (match?.[1]) {
      const detail = match[1].trim().replace(/[.\s]+$/, '')
      return `Bambu Studio can't slice this project as set up: ${detail}. Pick a filament and process preset made for the selected printer, then slice again.`
    }
  }
  return null
}
