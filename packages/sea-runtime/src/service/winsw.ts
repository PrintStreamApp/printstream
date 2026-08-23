/**
 * Windows service integration via WinSW (MIT-licensed service wrapper). The
 * packaged executable embeds `winsw.exe` as a SEA asset; install extracts it
 * next to the app binary as `<id>-service.exe` with a matching XML config, the
 * conventional WinSW layout. The service appears in services.msc and restarts
 * the app on failure (which is also how self-update restarts).
 *
 * The SEA asset lives in the consuming app's bundle, so the WinSW binary is
 * injected via `createWinswController({ resolveWinswAsset })` rather than read
 * here, this module stays free of any app-specific SEA accessor.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Windows-only paths; built with win32 semantics so config generation (and
// its tests) behave identically on any build host.
const winPath = path.win32
import { escapeXml } from './xml.js'
import { commandSucceeds, runCommand } from './exec.js'
import type { ServiceSpec } from './spec.js'

/** Conventional SEA asset key the app embeds the WinSW binary under. */
export const WINSW_ASSET_KEY = 'winsw.exe'

export interface WinswControllerOptions {
  /** Returns the embedded WinSW binary, or null when not packaged. */
  resolveWinswAsset: () => Buffer | null
}

export function winswWrapperPath(spec: ServiceSpec): string {
  return winPath.join(winPath.dirname(spec.exePath), `${spec.id}-service.exe`)
}

export function winswConfigPath(spec: ServiceSpec): string {
  return winPath.join(winPath.dirname(spec.exePath), `${spec.id}-service.xml`)
}

/**
 * Restart delays for Windows' three service-recovery slots (first failure, second failure,
 * SUBSEQUENT failures), in seconds. Declared once because two things must agree about them: the
 * WinSW XML written at install, and {@link ensureServiceRecoveryActions}, which re-asserts them on
 * an install that predates this policy. Escalating so a genuine crash-loop backs off.
 */
const RECOVERY_RESTART_DELAYS_SEC = [5, 10, 30] as const

/** How long a service must run cleanly before Windows forgets earlier failures. */
const RECOVERY_RESET_PERIOD_SEC = 60 * 60

/**
 * Re-apply the service's recovery actions, healing an install registered before the policy above.
 *
 * WHY THIS EXISTS AT RUNTIME. Recovery actions live in the Service Control Manager database, not in
 * the XML: they are written when `winsw install` registers the service, and an in-place self-update
 * only swaps the executable, so an existing install keeps whatever it was registered with forever.
 * Installs made before all three slots were filled restart ONCE and then stay Stopped, and the
 * thing that trips it is the update mechanism itself (a self-update exits with
 * SERVICE_RESTART_EXIT_CODE, which Windows counts as a failure), so the machines most likely to get
 * stuck are the ones actively updating and least likely to be reachable.
 *
 * Best-effort by contract: returns false and never throws. Modifying a service's own configuration
 * needs elevation, which the LocalSystem service account has and an interactive run may not, and a
 * bridge that cannot polish its recovery policy must still start.
 */
export function ensureServiceRecoveryActions(spec: ServiceSpec): boolean {
  if (process.platform !== 'win32') return false
  const actions = RECOVERY_RESTART_DELAYS_SEC.map((seconds) => `restart/${seconds * 1000}`).join('/')
  // `sc.exe` rather than re-running `winsw install`: this must not disturb a RUNNING service, and
  // the argument spacing is sc's own quirk (`reset= 3600`, space after the equals, not before).
  return commandSucceeds('sc.exe', ['failure', spec.id, 'reset=', String(RECOVERY_RESET_PERIOD_SEC), 'actions=', actions])
}

export function generateWinswConfig(spec: ServiceSpec): string {
  const environmentEntries = Object.entries(spec.env)
    .map(([key, value]) => `  <env name="${escapeXml(key)}" value="${escapeXml(value)}"/>`)
    .join('\n')

  // A non-LocalSystem account (e.g. NetworkService) is required when the service
  // runs PostgreSQL, which refuses to start under an administrative account.
  // `allowservicelogon` grants the "Log on as a service" right WinSW needs.
  const serviceAccount = spec.serviceAccount
    ? `  <serviceaccount>
    <username>${escapeXml(spec.serviceAccount)}</username>
    <allowservicelogon>true</allowservicelogon>
  </serviceaccount>
`
    : ''

  return `<service>
  <id>${escapeXml(spec.id)}</id>
  <name>${escapeXml(spec.displayName)}</name>
  <description>${escapeXml(spec.description)}</description>
  <executable>${escapeXml(spec.exePath)}</executable>
  <arguments>${escapeXml(spec.args.join(' '))}</arguments>
  <workingdirectory>${escapeXml(spec.dataDir)}</workingdirectory>
${environmentEntries}
${serviceAccount}  <!--
    THREE entries, not one. Windows service recovery has exactly three slots (first failure,
    second failure, subsequent failures) and WinSW fills them in order; whatever it is not given
    stays "Take No Action", and the third slot is the one Windows repeats forever. With a single
    entry the service restarted ONCE and then stayed Stopped, which is not a hypothetical: a
    self-update exits deliberately with SERVICE_RESTART_EXIT_CODE (75), Windows counts any
    non-zero exit as a failure, and resetfailure only clears the count after an hour of clean
    running. So a second intentional exit inside that hour (a follow-up update, a rollback boot,
    a crash right after swapping the exe) left the bridge Stopped until someone started it by
    hand. Observed on a real install, whose "sc qfailure" listed exactly one RESTART action.
    Escalating delays so a genuine crash-loop backs off instead of spinning. This is the Windows
    half of systemd's Restart=always (see systemd.ts), and the two must stay equivalent.
  -->
${RECOVERY_RESTART_DELAYS_SEC.map((seconds) => `  <onfailure action="restart" delay="${seconds} sec"/>`).join('\n')}
  <resetfailure>${RECOVERY_RESET_PERIOD_SEC / 3600} hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <log mode="roll-by-size">
    <logpath>${escapeXml(spec.logsDir)}</logpath>
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>4</keepFiles>
  </log>
</service>
`
}

/**
 * Builds the Windows (WinSW) service controller. The WinSW binary is supplied by
 * the app via `resolveWinswAsset` (its SEA asset), keeping this module free of
 * any app-specific SEA accessor.
 */
export function createWinswController(options: WinswControllerOptions) {
  return {
    async install(spec: ServiceSpec): Promise<void> {
      const winswBinary = options.resolveWinswAsset()
      if (!winswBinary) {
        throw new Error('The Windows service wrapper is only available in the packaged executable.')
      }
      await mkdir(spec.dataDir, { recursive: true })
      await mkdir(spec.logsDir, { recursive: true })
      const wrapperPath = winswWrapperPath(spec)
      await writeFile(wrapperPath, winswBinary)
      await writeFile(winswConfigPath(spec), generateWinswConfig(spec), 'utf8')
      runCommand(wrapperPath, ['install'])
      runCommand(wrapperPath, ['start'])
    },

    async uninstall(spec: ServiceSpec): Promise<void> {
      const wrapperPath = winswWrapperPath(spec)
      runCommand(wrapperPath, ['stop'], { allowFailure: true })
      runCommand(wrapperPath, ['uninstall'])
      await rm(winswConfigPath(spec), { force: true })
      await rm(wrapperPath, { force: true })
    },

    start(spec: ServiceSpec): void {
      runCommand(winswWrapperPath(spec), ['start'])
    },

    stop(spec: ServiceSpec): void {
      runCommand(winswWrapperPath(spec), ['stop'])
    },

    restart(spec: ServiceSpec): void {
      runCommand(winswWrapperPath(spec), ['restart'])
    },

    status(spec: ServiceSpec): string {
      const output = runCommand(winswWrapperPath(spec), ['status'], { allowFailure: true })
      return output?.trim() ?? 'not-installed'
    }
  }
}
