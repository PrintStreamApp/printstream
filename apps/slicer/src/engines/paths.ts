/**
 * Where an installed engine and its shared runtime live.
 *
 * Everything hangs off the manifest's own directory, so one setting
 * (`SLICER_TARGETS_FILE`) describes the whole layout and the container and the
 * native app share it without either knowing the other's paths.
 *
 * The **sysroot is shared, not per engine.** It is the Ubuntu runtime closure
 * the AppImages expect from the host — the same 314 MB regardless of which
 * engine loads it. Nesting it under one engine would download it again for the
 * second, and removing that engine would break the others; hence a sibling.
 *
 * Reserved names start with `_`, which no engine id can (they are all
 * `<family>-<version>`), so a shared directory can never collide with one.
 */
import path from 'node:path'
import { env } from '../env.js'

/** Root holding the manifest, every engine, and the shared runtime. */
export function enginesRoot(): string {
  return path.dirname(env.SLICER_TARGETS_FILE)
}

export function engineDir(id: string): string {
  return path.join(enginesRoot(), id)
}

/** Unpacked engine: `bambu-studio.exe` on Windows, `bin/bambu-studio` on Linux. */
export function engineAppDir(id: string): string {
  return path.join(engineDir(id), 'app')
}

/** Flattened machine/process/filament presets for one engine. */
export function engineProfileDir(id: string): string {
  return path.join(engineDir(id), 'profiles')
}

/** The shared Linux runtime closure. Sibling of the engines, deliberately. */
export function sharedSysrootDir(): string {
  return path.join(enginesRoot(), '_runtime', 'sysroot')
}

/** Scratch for in-flight downloads, swept by the installer on success. */
export function downloadsDir(): string {
  return path.join(enginesRoot(), '_runtime', 'downloads')
}
