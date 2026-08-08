/**
 * The installed-engine manifest, as something that changes while we run.
 *
 * `targets.json` used to be written once at image build time and only ever
 * read. Nothing writes it at build time any more — the container downloads its
 * engines at runtime like the native app — so this is the only writer, and it
 * accumulates: engines are added and removed on a running service.
 *
 * The install ROOT is the manifest's own directory. That keeps one setting
 * (`SLICER_TARGETS_FILE`) describing where engines live, and it is what lets the
 * container (`/opt/printstream-slicers`) and the native app (`<dataDir>/slicer`)
 * share this code without either knowing about the other's layout.
 *
 * Counterpart: `slicer-targets.ts` reads this; call
 * `invalidateSlicerTargetRegistry()` after any write here or the change is
 * invisible until a restart.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../env.js'

/** One installed engine, exactly as `slicer-targets.ts` expects to read it. */
export interface ManifestEngine {
  id: string
  label: string
  family: string
  version: string
  slicerName: string
  isDefault: boolean
  prerelease: boolean
  cliPath: string
  cliArgsPrefix?: string[]
  appDir: string
  profileDir: string
}

export interface EngineManifest {
  defaultTargetId: string | null
  targets: ManifestEngine[]
}

const EMPTY: EngineManifest = { defaultTargetId: null, targets: [] }

export function manifestPath(): string {
  return env.SLICER_TARGETS_FILE
}

/** Where an engine's files live. Derived, so there is no second setting to disagree. */
export function engineRoot(id: string): string {
  return path.join(path.dirname(manifestPath()), id)
}

export async function readManifest(): Promise<EngineManifest> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(), 'utf8')) as Partial<EngineManifest>
    return {
      defaultTargetId: parsed.defaultTargetId ?? null,
      targets: Array.isArray(parsed.targets) ? parsed.targets : []
    }
  } catch {
    // Absent or unreadable both mean "nothing installed": a service with no
    // engines is a valid state (a fresh native install before its first
    // download), not an error to crash on.
    return { ...EMPTY }
  }
}

/**
 * Which engine should be the default.
 *
 * Never a prerelease, however new. Bambu ships betas as GitHub pre-releases and
 * BambuStudio's own file-version refusal tells users a project should come from
 * a stable build; they exist only so a project saved by a beta desktop can be
 * sliced at all. So: the newest STABLE installed, falling back to whatever is
 * installed if a deployment has nothing but betas — a default that cannot slice
 * is worse than a beta one.
 */
export function chooseDefaultTargetId(targets: ManifestEngine[]): string | null {
  if (targets.length === 0) return null
  const stable = targets.filter((target) => !target.prerelease)
  const pool = stable.length > 0 ? stable : targets
  return [...pool].sort((a, b) => compareVersions(a.version, b.version)).at(-1)?.id ?? null
}

/** Numeric per segment: "2.10.0" is newer than "2.9.0", which a string sort gets wrong. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Add or replace one engine, then re-pick the default.
 *
 * Written to a temp file and renamed, so a reader never sees a half-written
 * manifest — `slicer-targets.ts` parses this on a schedule the writer does not
 * control.
 */
export async function upsertEngine(engine: Omit<ManifestEngine, 'isDefault'>): Promise<EngineManifest> {
  const current = await readManifest()
  const others = current.targets.filter((target) => target.id !== engine.id)
  const next = [...others, { ...engine, isDefault: false }]
  return writeManifest(next)
}

/** Drop one engine and re-pick the default. Removing what is not there is not an error. */
export async function removeEngineFromManifest(id: string): Promise<EngineManifest> {
  const current = await readManifest()
  return writeManifest(current.targets.filter((target) => target.id !== id))
}

async function writeManifest(targets: ManifestEngine[]): Promise<EngineManifest> {
  const defaultTargetId = chooseDefaultTargetId(targets)
  const manifest: EngineManifest = {
    defaultTargetId,
    // `isDefault` is DERIVED here rather than trusted from the caller, so the
    // flag and `defaultTargetId` cannot disagree — two representations of one
    // fact, and the build-time script writes both too.
    targets: targets.map((target) => ({ ...target, isDefault: target.id === defaultTargetId }))
  }
  const file = manifestPath()
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(temp, file)
  return manifest
}

/** The ids currently installed. The cheap question a host asks at boot. */
export async function readInstalledEngineIds(): Promise<string[]> {
  return (await readManifest()).targets.map((target) => target.id)
}
