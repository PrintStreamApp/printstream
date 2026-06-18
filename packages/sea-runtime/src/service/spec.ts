/**
 * Service definition shared by the per-OS controllers. Kept generic (id,
 * paths, args) rather than tied to any one app so every PrintStream SEA build —
 * the cloud bridge and the self-hosted native app — reuses the same service
 * plumbing. The app supplies its own identity through this spec.
 */
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
