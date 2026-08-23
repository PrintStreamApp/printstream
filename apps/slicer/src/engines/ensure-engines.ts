/**
 * Getting the engines this host is supposed to have.
 *
 * The container used to ship every engine baked into its image. Engines are
 * downloaded at runtime now, by the same installer the native app uses, into a
 * directory the operator chooses, which makes boot the moment a fresh install
 * has nothing to slice with.
 *
 * **What "supposed to have" means differs by who is running it**, which is the
 * whole reason this is configurable rather than always "the default":
 *
 * - A self-hosted install wants ONE engine (~530 MB) and adds others itself.
 *   That is the unset default.
 * - The hosted deployment wants ALL of them, because its users cannot install
 *   engines, engine management is refused there on purpose, and a project
 *   saved by an older Bambu Studio still has to be sliceable. It sets
 *   `SLICER_PRELOAD_ENGINES=all`.
 *
 * Only ever ADDS. Nothing here removes an engine an operator installed, and an
 * engine already present is skipped rather than refetched.
 *
 * **Best-effort and non-blocking, deliberately.** It runs after the server is
 * listening and never fails a boot: an install with no internet, or a slicer
 * started purely to serve profiles, must still come up. The cost is asymmetric,
 * a failed download is a log line and a retry next boot, whereas a download
 * that blocks `listen()` is a container that never reports healthy.
 */
import { defaultCatalogueEngine, listCatalogue } from './catalogue.js'
import { installEngine } from './install.js'
import { readManifest } from './manifest.js'
import { beginInstall, failInstall, finishInstall, reportInstall } from './progress.js'

export interface EnsureEnginesOutcome {
  /** Ids that were already installed and left alone. */
  present: string[]
  installed: string[]
  failed: string[]
  /** Requested by configuration but not installable on this host. */
  unavailable: string[]
}

/**
 * Which engines this host should end up with.
 *
 * Exported for tests, and because the parsing rule is worth pinning: an unknown
 * id is dropped rather than failing the whole list, so one stale entry in a
 * deployment's configuration cannot leave a slicer with no engine at all.
 */
export function resolvePreloadEngineIds(
  configured: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): { ids: string[]; unknown: string[] } {
  const installable = listCatalogue(platform, arch)
  const raw = (configured ?? '').trim()

  if (!raw) {
    const fallback = defaultCatalogueEngine(platform, arch)
    return { ids: fallback ? [fallback.id] : [], unknown: [] }
  }
  if (raw.toLowerCase() === 'all') {
    return { ids: installable.map((engine) => engine.id), unknown: [] }
  }

  const requested = raw.split(',').map((entry) => entry.trim()).filter(Boolean)
  const ids: string[] = []
  const unknown: string[] = []
  for (const id of requested) {
    if (installable.some((engine) => engine.id === id)) ids.push(id)
    else unknown.push(id)
  }
  return { ids, unknown }
}

/**
 * @returns what happened per engine, for tests and the boot log. Never throws.
 */
export async function ensureEnginesInstalled(
  configured: string | null | undefined
): Promise<EnsureEnginesOutcome> {
  const outcome: EnsureEnginesOutcome = { present: [], installed: [], failed: [], unavailable: [] }

  let installedIds: Set<string>
  try {
    installedIds = new Set((await readManifest()).targets.map((target) => target.id))
  } catch (error) {
    console.warn('[slicer] could not read the engine manifest; skipping the boot-time install', { error })
    return outcome
  }

  const { ids, unknown } = resolvePreloadEngineIds(configured)
  if (unknown.length > 0) {
    // Named, not silently dropped: a typo in a deployment's configuration is
    // otherwise invisible until someone cannot find the engine they expected.
    console.warn('[slicer] ignoring unknown engine ids in SLICER_PRELOAD_ENGINES', { unknown })
    outcome.unavailable.push(...unknown)
  }
  if (ids.length === 0) {
    if (installedIds.size === 0) {
      console.warn('[slicer] no installable engine for this platform; server-side slicing is unavailable')
    }
    return outcome
  }

  for (const id of ids) {
    if (installedIds.has(id)) {
      outcome.present.push(id)
      continue
    }
    // One at a time, on purpose: each is ~220 MB compressed and unpacks past a
    // gigabyte, and the progress surface reports a single install. Downloading
    // seven at once would compete for the same disk and tell the waiting user
    // less, not more.
    if (await installOne(id)) outcome.installed.push(id)
    else outcome.failed.push(id)
  }

  return outcome
}

async function installOne(id: string): Promise<boolean> {
  console.log(`[slicer] installing engine ${id}. Slicing with it is unavailable until it finishes.`)
  // Through the same tracker the HTTP install uses, so anyone waiting to slice
  // can be shown this one too. Reporting it only to the boot log would leave the
  // progress surface blank during the exact wait it exists for.
  beginInstall(id)
  try {
    await installEngine({
      id,
      onProgress: (progress) => {
        const fraction = progress.totalBytes != null && progress.totalBytes > 0 && progress.receivedBytes != null
          ? progress.receivedBytes / progress.totalBytes
          : undefined
        reportInstall(id, progress.label, fraction)
        // Phase changes only. A byte-level log on a 220 MB download would bury
        // everything else in the boot log.
        if (progress.phase === 'downloading' && progress.receivedBytes != null) return
        console.log(`[slicer] ${progress.label}`)
      }
    })
    finishInstall(id)
    console.log(`[slicer] engine ${id} is ready.`)
    return true
  } catch (error) {
    failInstall(id, error instanceof Error ? error.message : 'Install failed')
    console.warn(
      '[slicer] could not install an engine. Slicing with it stays unavailable until it is installed from Settings.',
      { engineId: id, error }
    )
    return false
  }
}
