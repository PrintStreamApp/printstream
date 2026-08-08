/**
 * Camera streaming needs ffmpeg, so standalone executables embed a pinned
 * static build (plus its GPL license text) as SEA assets. On startup this
 * module extracts it once into `<dataDir>/tools/ffmpeg-<tag>/` and points
 * `BRIDGE_FFMPEG_PATH` at it — the camera code in @printstream/bridge-runtime
 * spawns that path instead of relying on a system install. Operators can still
 * override with their own BRIDGE_FFMPEG_PATH; system PATH ffmpeg is the
 * fallback for dev runs and builds without the asset.
 *
 * Shared, because BOTH standalone builds relay cameras: the bridge executable
 * and the native self-hosted server, whose in-box bridge owns the LAN. The
 * server shipped without ffmpeg at first, which silently disabled the camera on
 * every RTSP printer (X/H series) while leaving the TLS ones (P1/A1) working —
 * a "camera is broken on my H2D" that looked like a printer-specific bug.
 *
 * The env var keeps its `BRIDGE_` name because it belongs to the camera runtime
 * in `@printstream/bridge-runtime`, which is what reads it, not to the bridge
 * application.
 *
 * Counterpart: `ensureFfmpegAssets` in the build harness embeds what this reads.
 */
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
const TOOLS_DIR_NAME = 'tools'
const FFMPEG_DIR_PREFIX = 'ffmpeg-'

export interface FfmpegStatus {
  /**
   * Where camera streaming gets ffmpeg from: an operator-provided
   * BRIDGE_FFMPEG_PATH, the bundled static build, a system install on PATH, or
   * nowhere (camera streaming disabled).
   */
  source: 'env' | 'bundled' | 'system' | 'missing'
  path: string | null
}

export interface EnsureFfmpegOptions {
  dataDir: string
  /** ffmpeg build tag from the SEA build info; null in dev runs. */
  versionTag: string | null
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  /**
   * Reads an embedded SEA asset. Required rather than defaulted: each
   * executable has its own asset reader, and guessing one here would silently
   * read nothing in the other.
   */
  readAsset: (key: string) => Buffer | null
  /** Injectable for tests; defaults to probing `ffmpeg -version` on PATH. */
  systemFfmpegWorks?: () => boolean
}

/**
 * Makes ffmpeg available for camera streaming and reports where it came from.
 * Sets BRIDGE_FFMPEG_PATH (in the provided env) when the bundled build is
 * used, so it must run before the runtime first touches the camera code.
 */
export async function ensureFfmpeg(options: EnsureFfmpegOptions): Promise<FfmpegStatus> {
  const env = options.env ?? process.env
  const readAsset = options.readAsset
  const platform = options.platform ?? process.platform

  const explicit = env.BRIDGE_FFMPEG_PATH?.trim()
  if (explicit) {
    return { source: 'env', path: explicit }
  }

  if (options.versionTag) {
    const extracted = await extractBundledFfmpeg({
      dataDir: options.dataDir,
      versionTag: options.versionTag,
      platform,
      readAsset
    }).catch((error) => {
      console.warn(`Could not extract the bundled ffmpeg: ${(error as Error).message}`)
      return null
    })
    if (extracted) {
      env.BRIDGE_FFMPEG_PATH = extracted
      return { source: 'bundled', path: extracted }
    }
  }

  const systemWorks = options.systemFfmpegWorks ?? defaultSystemFfmpegProbe
  if (systemWorks()) {
    return { source: 'system', path: 'ffmpeg' }
  }
  return { source: 'missing', path: null }
}

/**
 * Extracts the embedded ffmpeg into a version-tagged tools directory (once)
 * and prunes older extracted versions. Returns null when the running build
 * carries no ffmpeg asset (e.g. dev runs from plain compiled sources).
 */
async function extractBundledFfmpeg(input: {
  dataDir: string
  versionTag: string
  platform: NodeJS.Platform
  readAsset: (key: string) => Buffer | null
}): Promise<string | null> {
  const toolsDir = path.join(input.dataDir, TOOLS_DIR_NAME)
  const versionDir = path.join(toolsDir, `${FFMPEG_DIR_PREFIX}${input.versionTag}`)
  const exePath = path.join(versionDir, input.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

  if (!await pathExists(exePath)) {
    const binary = readFfmpegAssetBinary(input.readAsset)
    if (!binary) return null
    await mkdir(versionDir, { recursive: true })
    // Write-then-rename so a crash mid-extraction never leaves a half-written
    // binary at the path the camera code will execute.
    const tempPath = `${exePath}.extracting`
    await writeFile(tempPath, binary, { mode: 0o755 })
    await chmod(tempPath, 0o755).catch(() => undefined)
    await rename(tempPath, exePath)
    const license = input.readAsset('ffmpeg-license')
    if (license) {
      await writeFile(path.join(versionDir, 'LICENSE'), license)
    }
  }

  await pruneOldFfmpegVersions(toolsDir, path.basename(versionDir))
  return exePath
}

/**
 * The build embeds ffmpeg brotli-compressed (`ffmpeg.br`, ~24 MB vs ~76 MB
 * raw) to keep the executable small; a raw `ffmpeg` asset remains supported
 * as a fallback shape.
 */
function readFfmpegAssetBinary(readAsset: (key: string) => Buffer | null): Buffer | null {
  const compressed = readAsset('ffmpeg.br')
  if (compressed) return brotliDecompressSync(compressed)
  return readAsset('ffmpeg')
}

async function pruneOldFfmpegVersions(toolsDir: string, keepDirName: string): Promise<void> {
  const entries = await readdir(toolsDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(FFMPEG_DIR_PREFIX) || entry.name === keepDirName) continue
    await rm(path.join(toolsDir, entry.name), { recursive: true, force: true }).catch(() => undefined)
  }
}

function defaultSystemFfmpegProbe(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false)
}
