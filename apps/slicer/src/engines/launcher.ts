/**
 * How the native app invokes the slicing engine, per platform.
 *
 * Pure: it builds a command, it does not run one. The slicer service spawns
 * whatever `cliPath`/`cliArgsPrefix` the engine manifest names, so getting this
 * shape right is the whole platform-specific surface.
 *
 * TWO strategies, because the container and the native app genuinely differ in
 * what they can assume, and pretending otherwise is what kept them on separate
 * installers for so long:
 *
 * - `native` — an engine installed at runtime onto an unknown machine. No shell
 *   guarantees on Windows, no display (measured: the CLI slices with glfwInit
 *   failing, and plate thumbnails are supplied by the caller), and on Linux it
 *   must bind to the sysroot we installed rather than the host's libraries.
 * - `container` — our own image, which already carries the runtime libraries as
 *   OS packages (amd64) or a baked x86-64 sysroot for qemu (arm64), plus Xvfb.
 *   `docker/bambu-studio-cli.sh` is what knows how to combine those, and it
 *   takes the engine's directory through `SLICER_APPDIR`, which every spawn site
 *   already sets from the manifest.
 *
 * The strategy is what decides whether an install needs to fetch a sysroot at
 * all — a question that used to be answered by platform alone, which is why
 * installing an engine inside the container demanded a closure it neither had
 * nor needed.
 */
import path from 'node:path'

export interface SlicerEngineLayout {
  /** Unpacked engine root: `bambu-studio.exe` on Windows, `bin/bambu-studio` on Linux. */
  appDir: string
  /** Unpacked runtime sysroot. Linux only; absent elsewhere. */
  sysrootDir?: string
}

export interface SlicerEngineCommand {
  execute: string
  /** Prepended to every invocation, before the slicer's own arguments. */
  argsPrefix: string[]
}

/**
 * How this host runs an engine. See the module header.
 *
 * `container` is set by our own image and nothing else; every other build is
 * `native`, which is the conservative answer (it assumes nothing about the
 * machine).
 */
export type SlicerEngineLaunchStrategy = 'native' | 'container'

/** Where the container image keeps the launcher that knows about Xvfb and qemu. */
export const CONTAINER_LAUNCHER_PATH = '/usr/local/bin/slicer-cli'

/**
 * Whether an install under this strategy has to fetch the shared runtime
 * closure.
 *
 * Only the native strategy does: it runs the engine through the sysroot's own
 * loader precisely so the install does not depend on the host distribution. The
 * container already provides those libraries, so demanding them there fails an
 * install that would have worked.
 */
export function launchStrategyNeedsSysroot(
  strategy: SlicerEngineLaunchStrategy,
  platform: NodeJS.Platform = process.platform
): boolean {
  return strategy === 'native' && platform === 'linux'
}

/**
 * Build the command that runs the engine.
 *
 * **Windows** is direct: the portable build bundles every DLL it needs beside
 * the executable, so there is nothing to wire up. Verified end to end on
 * Windows 11 ARM under Prism emulation, including from session 0 as SYSTEM.
 *
 * **Linux** runs the engine through the SYSROOT'S OWN dynamic loader with an
 * explicit `--library-path`, instead of executing the binary directly. That is
 * what makes the install independent of the host distribution: executing it
 * normally would resolve GTK, WebKit and the rest against whatever the machine
 * happens to have, which on a headless server is nothing and on a desktop is
 * often the wrong WebKit ABI. The AppImage's own `bin/` comes FIRST on that
 * path — it bundles libavcodec/libavutil/libswscale and nothing else, and those
 * three are not in the sysroot. Verified: a full slice, exit 0, with no host
 * library reachable.
 */
export function buildSlicerEngineCommand(
  layout: SlicerEngineLayout,
  platform: NodeJS.Platform = process.platform,
  strategy: SlicerEngineLaunchStrategy = 'native'
): SlicerEngineCommand {
  // The image's launcher takes the engine directory through `SLICER_APPDIR`
  // rather than an argument, and every spawn site already sets it from the
  // manifest's `appDir` — so there is nothing to prefix.
  if (strategy === 'container') {
    return { execute: CONTAINER_LAUNCHER_PATH, argsPrefix: [] }
  }

  if (platform === 'win32') {
    return { execute: path.win32.join(layout.appDir, 'bambu-studio.exe'), argsPrefix: [] }
  }

  if (!layout.sysrootDir) {
    throw new Error('A Linux slicer engine needs its runtime sysroot; none was installed.')
  }
  const binary = path.posix.join(layout.appDir, 'bin', 'bambu-studio')
  const loader = path.posix.join(layout.sysrootDir, 'lib64', 'ld-linux-x86-64.so.2')
  const libraryPath = [
    // First: the three libraries the AppImage carries and the sysroot lacks.
    path.posix.join(layout.appDir, 'bin'),
    path.posix.join(layout.sysrootDir, 'lib', 'x86_64-linux-gnu'),
    path.posix.join(layout.sysrootDir, 'usr', 'lib', 'x86_64-linux-gnu'),
    path.posix.join(layout.sysrootDir, 'lib64')
  ].join(':')
  return { execute: loader, argsPrefix: ['--library-path', libraryPath, binary] }
}
