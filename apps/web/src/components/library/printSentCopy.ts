/**
 * Copy for the "print sent" confirmation (`PrintSentDialog`).
 *
 * Kept apart from the component so the wording is testable without rendering Joy.
 * It has to survive a multi-printer send, which is the normal case here.
 */

/**
 * Sentence naming the file that was dispatched and where it went.
 *
 * `PrintModal` sends to every selected printer, so the count leads and the names
 * follow rather than growing an unbounded conjunction. An empty list can only
 * happen if a printer row disappeared between the send and the confirmation, so
 * it degrades to the unnamed form instead of asserting a printer we can't name.
 */
export function formatPrintSentMessage(fileName: string, printerNames: string[]): string {
  if (printerNames.length === 1) return `${fileName} is on its way to ${printerNames[0]}.`
  if (printerNames.length > 1) {
    return `${fileName} is on its way to ${printerNames.length} printers: ${printerNames.join(', ')}.`
  }
  return `${fileName} is on its way to the printer.`
}
