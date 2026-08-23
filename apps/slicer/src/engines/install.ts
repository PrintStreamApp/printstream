/**
 * Install and remove slicer engines on a running service.
 *
 * Engines used to be baked into the container image at build time: seven of
 * them, ~7 GB. They are now managed at runtime, which is what lets the native
 * app ship with none and fetch the one it needs, and lets any operator add a
 * version to slice a project a newer desktop build saved.
 *
 * Two ordering rules carry the safety:
 *
 * - The MANIFEST ENTRY IS WRITTEN LAST. A failure part way through leaves an
 *   unreferenced directory, never a registered engine whose files are missing:
 *   the slicer would spawn the latter and fail per slice instead of once.
 * - The SHARED SYSROOT is installed before the engine that needs it and removed
 *   only with the last one. It is the Ubuntu runtime closure every Linux engine
 *   loads, so nesting it under one engine would re-download it for the next and
 *   break the rest when that one went.
 *
 * Counterparts: `catalogue.ts` (what may be installed), `manifest.ts` (what is),
 * `launcher.ts` (how the result is invoked).
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { generateFullProfiles } from '../../docker/generate-bambustudio-full-profiles.mjs'
import { pruneDebugFiles } from './prune-debug-files.js'
import { configuredSharedRuntime, engineLaunchStrategy, findCatalogueEngine, needsSharedSysroot, type CatalogueEngine, type EngineAsset } from './catalogue.js'
import { extractZip } from './extract-zip.js'
import { buildSlicerEngineCommand } from './launcher.js'
import { readManifest, removeEngineFromManifest, upsertEngine } from './manifest.js'
import { downloadsDir, engineAppDir, engineDir, engineProfileDir, sharedSysrootDir } from './paths.js'
import { invalidateSlicerTargetRegistry } from '../slicer-targets.js'

const run = promisify(execFile)

export interface EngineInstallProgress {
  phase: 'checking' | 'downloading' | 'extracting' | 'profiles' | 'done'
  label: string
  receivedBytes?: number
  totalBytes?: number
}

export interface InstallEngineOptions {
  id: string
  onProgress?: (progress: EngineInstallProgress) => void
  signal?: AbortSignal
}

export async function installEngine(options: InstallEngineOptions): Promise<void> {
  const report = options.onProgress ?? (() => undefined)
  const engine = findCatalogueEngine(options.id)
  if (!engine) throw new Error(`No installable engine named ${options.id} on this platform.`)

  const manifest = await readManifest()
  if (manifest.targets.some((target) => target.id === engine.id)) {
    report({ phase: 'done', label: `${engine.label} is already installed.` })
    return
  }

  const wantsSysroot = needsSharedSysroot()
  const sysrootInstalled = await pathExists(sharedSysrootDir())
  // From configuration, never the request: the engine executes against these
  // libraries, so a caller-chosen archive would be arbitrary code.
  const sharedRuntime = configuredSharedRuntime()
  if (wantsSysroot && !sysrootInstalled && !sharedRuntime) {
    throw new Error('This engine needs the Linux runtime libraries, and this deployment is not configured to fetch them.')
  }

  report({ phase: 'checking', label: 'Checking available disk space' })
  const runtimeBytes = wantsSysroot && !sysrootInstalled && sharedRuntime
    ? sharedRuntime.bytes + 320_000_000
    : 0
  await assertFreeSpace(engine.asset.bytes + engine.installBytes + runtimeBytes)

  const scratch = downloadsDir()
  await mkdir(scratch, { recursive: true })

  try {
    if (wantsSysroot && !sysrootInstalled && sharedRuntime) {
      const archive = path.join(scratch, 'runtime.tar.gz')
      await downloadPinned(sharedRuntime, archive, options.signal, (received, total) => {
        report({ phase: 'downloading', label: 'Downloading the Linux runtime libraries', receivedBytes: received, totalBytes: total })
      })
      report({ phase: 'extracting', label: 'Unpacking the runtime libraries' })
      await mkdir(sharedSysrootDir(), { recursive: true })
      // `--strip-components=1` drops the wrapper directory the packer adds.
      await run('tar', ['-xzf', archive, '-C', sharedSysrootDir(), '--strip-components=1'])
      await rm(archive, { force: true })
    }

    const target = engineDir(engine.id)
    // Build into a clean directory: a previous failed attempt must not leave
    // files that make this one look complete.
    await rm(target, { recursive: true, force: true })

    const archive = path.join(scratch, `${engine.id}${engine.asset.url.endsWith('.zip') ? '.zip' : '.AppImage'}`)
    await downloadPinned(engine.asset, archive, options.signal, (received, total) => {
      report({ phase: 'downloading', label: `Downloading ${engine.label}`, receivedBytes: received, totalBytes: total })
    })

    report({ phase: 'extracting', label: `Unpacking ${engine.label}` })
    if (archive.endsWith('.zip')) await extractZip(archive, engineAppDir(engine.id))
    else await extractAppImage(archive, engineAppDir(engine.id))
    await rm(archive, { force: true })

    // Before the profile step, so the manager never reports an engine "ready"
    // at a size it is about to shrink. Debug symbols are ~69% of the Windows
    // engine and nothing reads them; see `prune-debug-files.ts`.
    const pruned = await pruneDebugFiles(engineAppDir(engine.id))
    if (pruned.files > 0) {
      console.log(`[engines] dropped ${pruned.files} debug file(s), freeing `
        + `${Math.round(pruned.bytes / 1_000_000)} MB from ${engine.label}`)
    }

    report({ phase: 'profiles', label: 'Preparing printer profiles' })
    await generateFullProfiles(path.join(engineAppDir(engine.id), 'resources', 'profiles'), engineProfileDir(engine.id))

    await registerEngine(engine)
    report({ phase: 'done', label: `${engine.label} is ready.` })
  } catch (error) {
    // Nothing half-installed is left registered; the directory is swept so a
    // retry starts clean rather than resuming an unknown state.
    await rm(engineDir(engine.id), { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Remove one engine, and the shared runtime with the last of them.
 *
 * Deregistered BEFORE its files go, so a slice can never resolve a target whose
 * directory is being deleted underneath it.
 */
export async function removeEngine(id: string): Promise<void> {
  const manifest = await removeEngineFromManifest(id)
  invalidateSlicerTargetRegistry()
  await rm(engineDir(id), { recursive: true, force: true })

  if (manifest.targets.length === 0 && needsSharedSysroot()) {
    // Only with the last engine: the closure is shared, and reclaiming it while
    // another engine still loads it would break that one instead.
    await rm(path.dirname(sharedSysrootDir()), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Written last: registration is what makes an engine live. */
async function registerEngine(engine: CatalogueEngine): Promise<void> {
  const command = buildSlicerEngineCommand(
    {
      appDir: engineAppDir(engine.id),
      sysrootDir: needsSharedSysroot() ? sharedSysrootDir() : undefined
    },
    process.platform,
    engineLaunchStrategy()
  )
  await upsertEngine({
    id: engine.id,
    label: engine.label,
    family: engine.family,
    version: engine.version,
    slicerName: engine.slicerName,
    prerelease: engine.prerelease,
    cliPath: command.execute,
    cliArgsPrefix: command.argsPrefix,
    appDir: engineAppDir(engine.id),
    profileDir: engineProfileDir(engine.id)
  })
  invalidateSlicerTargetRegistry()
}

async function assertFreeSpace(requiredBytes: number): Promise<void> {
  let available: number
  try {
    const stats = await statfs(downloadsDir())
    available = Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return // Cannot tell; attempting beats refusing wrongly.
  }
  if (available >= requiredBytes) return
  const gb = (value: number) => `${(value / 1_000_000_000).toFixed(1)} GB`
  throw new Error(`This engine needs about ${gb(requiredBytes)} free, and ${gb(available)} is available.`)
}

/** Stream to disk, hashing as it goes; a mismatch removes the file. */
async function downloadPinned(
  asset: EngineAsset,
  destination: string,
  signal: AbortSignal | undefined,
  onProgress: (receivedBytes: number, totalBytes: number) => void
): Promise<void> {
  const response = await fetch(asset.url, { signal })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (HTTP ${response.status}).`)
  }
  const total = Number(response.headers.get('content-length') ?? asset.bytes)
  const hash = createHash('sha256')
  let received = 0
  let lastReport = 0
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    received += chunk.length
    if (received - lastReport >= 4_000_000 || received === total) {
      lastReport = received
      onProgress(received, total)
    }
  })
  await pipeline(body, createWriteStream(destination))

  if (hash.digest('hex') !== asset.sha256) {
    await rm(destination, { force: true })
    throw new Error('The download did not match its expected checksum and was discarded. Try again.')
  }
}

/**
 * Unpack an AppImage without squashfs tools on the host.
 *
 * Type-2 AppImages self-extract with `--appimage-extract`, needing neither FUSE
 * nor unsquashfs, only that the runtime can execute, which on the x86-64 hosts
 * this serves it can. It writes `squashfs-root` into the CWD, so it runs with
 * `cwd` set and the result is renamed into place.
 */
async function extractAppImage(appImagePath: string, appDir: string): Promise<void> {
  const workDir = path.dirname(appImagePath)
  await chmod(appImagePath, 0o755)
  // An AppImage unpacks by RUNNING itself, and the artifact is x86-64. On arm64
  // that only works through the same emulator the container uses to run the
  // engine, invoked explicitly rather than trusting the host to have registered
  // a binfmt handler, a Raspberry Pi generally has not.
  const emulator = appImageEmulator()
  if (emulator) {
    await run(emulator, [appImagePath, '--appimage-extract'], { cwd: workDir, maxBuffer: 32 * 1024 * 1024 })
  } else {
    await run(appImagePath, ['--appimage-extract'], { cwd: workDir, maxBuffer: 32 * 1024 * 1024 })
  }
  const extracted = path.join(workDir, 'squashfs-root')
  if (!(await pathExists(extracted))) throw new Error('The engine archive did not unpack as expected.')
  await rm(appDir, { recursive: true, force: true })
  await mkdir(path.dirname(appDir), { recursive: true })
  await rename(extracted, appDir)
}

/**
 * The emulator needed to execute the x86-64 engine artifact here, or null when
 * the host runs it directly.
 *
 * Mirrors `docker/bambu-studio-cli.sh`, which reaches for the same binary under
 * the same variable: the launcher and the installer must agree about how an
 * x86-64 binary gets executed on this machine, or an engine installs and then
 * cannot start.
 */
function appImageEmulator(): string | null {
  if (process.arch !== 'arm64' || process.platform !== 'linux') return null
  return process.env.SLICER_QEMU_BIN ?? 'qemu-x86_64-static'
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false)
}
