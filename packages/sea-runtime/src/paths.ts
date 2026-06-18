/**
 * Per-OS filesystem layout primitives for standalone (single-executable) SEA
 * installs, parameterized by an app identity so any PrintStream SEA build can
 * reuse them. These resolve only the OS-level locations (data dir, install dir,
 * exe name, control-socket endpoint); the *domain* files an app keeps inside its
 * data dir (state, library, update bookkeeping, ...) are composed by the app on
 * top of `resolveStandaloneDataDir`.
 *
 * Everything derives from an explicit context object so the per-OS rules are
 * unit-testable on any host platform.
 */
import path from 'node:path'

/** Identity an app stamps onto its install locations and service definitions. */
export interface StandaloneAppIdentity {
  /** Machine id: install-dir basename, Linux service user, Unix dir name. */
  appId: string
  /** Human name: Windows dir name (`%ProgramData%\<displayName>`). */
  displayName: string
}

export interface StandalonePlatformContext {
  platform: NodeJS.Platform
  arch: string
  /** uid 0 on POSIX; Windows always uses machine-wide locations. */
  isPrivileged: boolean
  env: Record<string, string | undefined>
  homeDir: string
}

export function currentPlatformContext(): StandalonePlatformContext {
  return {
    platform: process.platform,
    arch: process.arch,
    isPrivileged: process.platform === 'win32' ? true : typeof process.getuid === 'function' && process.getuid() === 0,
    env: process.env,
    homeDir: process.env.HOME ?? process.env.USERPROFILE ?? '/'
  }
}

/** Manifest/asset key for standalone binaries, e.g. `linux-x64`, `win32-x64`. */
export function standalonePlatformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

/** Path helpers matching the target platform (not the build/test host). */
export function platformPath(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

export function standaloneExeName(identity: StandaloneAppIdentity, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${identity.appId}.exe` : identity.appId
}

/** Control-channel endpoint: a Windows named pipe or a Unix socket file. */
export function standaloneControlSocket(
  identity: StandaloneAppIdentity,
  platform: NodeJS.Platform,
  dataDir: string
): string {
  return platform === 'win32'
    ? `\\\\.\\pipe\\${identity.appId}`
    : platformPath(platform).join(dataDir, 'control.sock')
}

/** Default root for an app's data dir (before any app-specific env override). */
export function resolveStandaloneDataDir(context: StandalonePlatformContext, identity: StandaloneAppIdentity): string {
  if (context.platform === 'win32') {
    const programData = context.env.ProgramData ?? 'C:\\ProgramData'
    return path.win32.join(programData, identity.displayName)
  }
  if (context.isPrivileged) {
    return `/var/lib/${identity.appId}`
  }
  const xdgDataHome = context.env.XDG_DATA_HOME ?? path.posix.join(context.homeDir, '.local/share')
  return path.posix.join(xdgDataHome, identity.appId)
}

/** Default location `service install` copies the executable to. */
export function resolveStandaloneInstallDir(context: StandalonePlatformContext, identity: StandaloneAppIdentity): string {
  if (context.platform === 'win32') {
    const programFiles = context.env.ProgramFiles ?? 'C:\\Program Files'
    return path.win32.join(programFiles, identity.displayName)
  }
  return `/opt/${identity.appId}`
}
