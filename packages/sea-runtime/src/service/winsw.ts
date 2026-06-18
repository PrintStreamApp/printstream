/**
 * Windows service integration via WinSW (MIT-licensed service wrapper). The
 * packaged executable embeds `winsw.exe` as a SEA asset; install extracts it
 * next to the app binary as `<id>-service.exe` with a matching XML config, the
 * conventional WinSW layout. The service appears in services.msc and restarts
 * the app on failure (which is also how self-update restarts).
 *
 * The SEA asset lives in the consuming app's bundle, so the WinSW binary is
 * injected via `createWinswController({ resolveWinswAsset })` rather than read
 * here — this module stays free of any app-specific SEA accessor.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Windows-only paths; built with win32 semantics so config generation (and
// its tests) behave identically on any build host.
const winPath = path.win32
import { escapeXml } from './xml.js'
import { runCommand } from './exec.js'
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
${serviceAccount}  <onfailure action="restart" delay="5 sec"/>
  <resetfailure>1 hour</resetfailure>
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
