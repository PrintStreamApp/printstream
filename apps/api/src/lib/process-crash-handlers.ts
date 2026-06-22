/**
 * Process-level crash handlers.
 *
 * Without these, an `uncaughtException` (a synchronous throw in a callback/event
 * handler) or an `unhandledRejection` (a fire-and-forget `void promise` that
 * rejects) terminates the process with only Node's default output. In Docker that
 * is at least captured by the orchestrator; in the native single-file/tray build
 * stdout is redirected to a file the operator can't easily reach, so the app just
 * vanishes with no diagnosable reason.
 *
 * These handlers guarantee the failure is logged to the same sink as other
 * diagnostics, then exit non-zero so the orchestrator (cloud) or service
 * supervisor/tray (native) restarts a clean process — the standard posture, since
 * process state is unreliable after an uncaught fault. The log/exit seams are
 * injectable so the behavior is unit-testable without emitting real process events.
 */
export interface CrashHandlerOptions {
  /** Diagnostic sink. Defaults to `console.error`. */
  log?: (message: string, error: unknown) => void
  /** Exit hook. Defaults to `process.exit`. */
  exit?: (code: number) => void
}

export interface InstalledCrashHandlers {
  onUncaughtException: (error: unknown) => void
  onUnhandledRejection: (reason: unknown) => void
  /** Removes the listeners (mainly for tests). */
  uninstall: () => void
}

export function installProcessCrashHandlers(options: CrashHandlerOptions = {}): InstalledCrashHandlers {
  const log = options.log ?? ((message, error) => console.error(message, error))
  const exit = options.exit ?? ((code) => process.exit(code))

  const onUncaughtException = (error: unknown): void => {
    log('[fatal] Uncaught exception; exiting for a clean restart', error)
    exit(1)
  }
  const onUnhandledRejection = (reason: unknown): void => {
    log('[fatal] Unhandled promise rejection; exiting for a clean restart', reason)
    exit(1)
  }

  process.on('uncaughtException', onUncaughtException)
  process.on('unhandledRejection', onUnhandledRejection)

  return {
    onUncaughtException,
    onUnhandledRejection,
    uninstall: () => {
      process.off('uncaughtException', onUncaughtException)
      process.off('unhandledRejection', onUnhandledRejection)
    }
  }
}
