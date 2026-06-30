/**
 * Pure helpers for interpreting BambuStudio CLI progress output.
 *
 * Kept out of index.ts (which boots the HTTP server on import) so the matchers are
 * unit-testable without starting the service.
 */

/**
 * BambuStudio prints this exact progress line once a slice — including the final
 * gcode/3MF export — has fully succeeded. It is the last message before the process
 * exits, so seeing it means the output file is completely written.
 *
 * Under qemu emulation (arm64 dev / self-host) the process can then hang in teardown
 * without ever firing `close`, leaving the slice "stuck at 97% (Exporting 3mf)". The
 * slicer treats this marker (plus a short grace period for a clean exit) as completion
 * so a wedged teardown no longer waits out the full slice timeout.
 */
export function outputSignalsSliceComplete(text: string): boolean {
  return /"message"\s*:\s*"All done,\s*Success"/u.test(text)
}
