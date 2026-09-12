/**
 * Unix identity boundary for every third-party native slicer process.
 *
 * In the container, the HTTP/engine-management service runs as root with a deliberately tiny
 * capability set, while each hostile BambuStudio job receives a private numeric uid and gid.
 * Engine files stay root-owned and mode 0755, so the native parser can execute but cannot replace
 * them. Disposable job directories are root-owned and mode 0770, and only that job's group can
 * traverse them. Native/Windows development keeps the current identity.
 */
import type { SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, chown, mkdir } from 'node:fs/promises'
import { env } from './env.js'

const JOB_ID_BASE = 100_000
const JOB_ID_RANGE = 2_000_000_000

const ENGINE_ENVIRONMENT_KEYS = new Set([
  'BAMBUSTUDIO_APPDIR',
  'COMSPEC',
  'DISPLAY',
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  'GALLIUM_DRIVER',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LIBGL_ALWAYS_SOFTWARE',
  'LIBGL_DRIVERS_PATH',
  'LOGNAME',
  'NUMBER_OF_PROCESSORS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'QEMU_LD_PREFIX',
  'SHELL',
  'SLICER_APPDIR',
  'SLICER_GL_SHIM',
  'SLICER_MAX_FILE_BLOCKS',
  'SLICER_QEMU_BIN',
  'SLICER_QEMU_SYSROOT',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR'
])

/**
 * Spawn options that drop a container-root service into the dedicated engine runner.
 *
 * Each hostile job receives stable, high-numbered ids derived from its server-issued id. The work
 * tree is accessible only to that identity, and peer jobs cannot signal or inspect its processes
 * through same-user Unix permissions.
 */
export function engineProcessIdentity(jobKey?: string): Pick<SpawnOptions, 'uid' | 'gid'> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return {}
  }
  if (jobKey) {
    const digest = createHash('sha256').update(jobKey).digest()
    return {
      uid: JOB_ID_BASE + (digest.readUInt32BE(0) % JOB_ID_RANGE),
      gid: JOB_ID_BASE + (digest.readUInt32BE(4) % JOB_ID_RANGE)
    }
  }
  return {
    uid: env.SLICER_ENGINE_UID,
    gid: env.SLICER_ENGINE_GID
  }
}

/**
 * Build the native engine's complete environment from non-secret runtime settings.
 *
 * The slicer bearer token and any unrelated deployment credentials must never be inherited by a
 * parser handling hostile input. Keys are compared case-insensitively for Windows compatibility;
 * locale categories are the only prefix-based allowance.
 */
export function engineProcessEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase()
    if (ENGINE_ENVIRONMENT_KEYS.has(normalizedKey) || normalizedKey.startsWith('LC_')) {
      result[key] = value
    }
  }
  return { ...result, ...overrides }
}

/** Make one disposable work directory accessible only to its native job group. */
export async function prepareEngineWritableDirectory(directory: string, jobKey?: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o770 })
  const identity = engineProcessIdentity(jobKey)
  if (identity.gid != null) await chown(directory, 0, identity.gid)
  await chmod(directory, 0o770)
}
