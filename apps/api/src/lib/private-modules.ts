/**
 * Loader for first-party private modules under `src/private/<name>/`.
 *
 * The private directory holds closed-source functionality (the hosted
 * cloud deployment's marketing and tenant-administration surface) and is
 * stripped from the public open-source export, so the loader must treat a
 * missing directory as the normal case. Modules are discovered with a
 * filesystem scan instead of static imports precisely so the core compiles
 * and runs identically with or without them.
 *
 * Each module directory exposes an `index.ts` whose default export is a
 * {@link PrivateApiModule}. Invariants:
 * - Private modules may import from `src/lib`; core code must never import
 *   from `src/private`.
 * - `register()` runs during app wiring, before the error handler is
 *   attached, and may mount routes at top-level `/api/...` paths.
 */
import { readdir, stat } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Express } from 'express'

export interface PrivateApiModule {
  name: string
  register(app: Express): void | Promise<void>
}

/** Resolves `src/private` (or `dist/private` after compilation). */
function defaultPrivateModulesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../private')
}

/**
 * Synchronously reports whether any first-party private (cloud) module is
 * present. The public open-source export strips `src/private` entirely, so this
 * doubles as the canonical "is this the cloud build?" signal. Used at startup
 * (before the async module load) to pick build-exclusive behavior such as the
 * active auth provider — see `isSelfHostedDeployment`.
 */
export function hasPrivateModules(dirOverride?: string): boolean {
  const modulesDir = dirOverride ?? defaultPrivateModulesDir()
  try {
    return readdirSync(modulesDir).some((entry) => {
      try {
        return statSync(path.join(modulesDir, entry)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/**
 * Discovers and registers every private module. Returns the names of the
 * modules that were mounted (empty in public builds). `dirOverride` exists
 * for tests only.
 */
export async function registerPrivateModules(app: Express, dirOverride?: string): Promise<string[]> {
  const modulesDir = dirOverride ?? defaultPrivateModulesDir()
  let entries: string[]
  try {
    entries = await readdir(modulesDir)
  } catch {
    return []
  }

  const registered: string[] = []
  for (const entry of entries.sort()) {
    const moduleDir = path.join(modulesDir, entry)
    if (!(await stat(moduleDir)).isDirectory()) continue

    const entryFile = await resolveModuleEntry(moduleDir)
    if (!entryFile) continue

    const imported = await import(pathToFileURL(entryFile).href) as { default?: PrivateApiModule }
    const privateModule = imported.default
    if (!privateModule || typeof privateModule.register !== 'function') {
      throw new Error(`Private module "${entry}" must default-export a PrivateApiModule.`)
    }

    await privateModule.register(app)
    registered.push(privateModule.name)
  }

  return registered
}

/** Prefers compiled output, falls back to TypeScript source under tsx. */
async function resolveModuleEntry(moduleDir: string): Promise<string | null> {
  for (const candidate of ['index.js', 'index.ts']) {
    const candidatePath = path.join(moduleDir, candidate)
    try {
      if ((await stat(candidatePath)).isFile()) return candidatePath
    } catch {
      // keep looking
    }
  }
  return null
}
