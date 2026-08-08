/**
 * Service definition shared by the per-OS controllers. Kept generic (id,
 * paths, args) rather than tied to any one app so every PrintStream SEA build —
 * the cloud bridge and the self-hosted native app — reuses the same service
 * plumbing. The app supplies its own identity through this spec.
 */
/**
 * Exit code an app uses to say "restart me" to its service manager.
 *
 * **It must be non-zero, and that is the entire point.** WinSW restarts only on
 * a FAILED exit; a zero exit is a clean stop, so the service stays stopped. An
 * app that exits 0 to be restarted — after a self-update, or after rolling back
 * to a restored binary — therefore never comes back on Windows, while systemd's
 * `Restart=always` brings it back and hides the bug entirely. That asymmetry is
 * why this is a shared constant rather than a literal at each exit: the exit
 * code and the two service definitions are one contract.
 *
 * 75 is EX_TEMPFAIL — "temporary failure, try again" — which is what this is.
 * The systemd unit lists it in `SuccessExitStatus` so an intentional restart is
 * not reported as a failed unit.
 */
export const SERVICE_RESTART_EXIT_CODE = 75

export interface ServiceSpec {
  /** Machine identifier: systemd unit name, WinSW id, install dir basename. */
  id: string
  displayName: string
  description: string
  /** Optional documentation URL (systemd `Documentation=`); omitted when unset. */
  documentationUrl?: string
  /** Absolute path of the installed executable the service runs. */
  exePath: string
  args: string[]
  dataDir: string
  logsDir: string
  /** Environment pinned in the service definition (e.g. BRIDGE_DATA_DIR). */
  env: Record<string, string>
  /** Optional dotenv file the service should read (systemd EnvironmentFile). */
  configFile?: string
  /** POSIX user the service runs as (Linux only). */
  serviceUser?: string
  /**
   * Windows-only: the built-in account the service logs on as (e.g.
   * `NT AUTHORITY\\NetworkService`). When unset the service runs as LocalSystem.
   * The self-hosted server sets NetworkService because **PostgreSQL refuses to
   * run under an administrative account** like LocalSystem; the bridge has no
   * such constraint and leaves it unset.
   */
  serviceAccount?: string
}
