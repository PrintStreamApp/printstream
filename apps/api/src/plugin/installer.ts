/**
 * External plugin installer.
 *
 * Plugins ship as `.zip` archives that contain a `plugin.json` manifest
 * at the root and an ESM JavaScript entry whose default export is an
 * `ApiPlugin`. This module owns the install/uninstall lifecycle for
 * those archives:
 *
 * 1. Validate the manifest (Zod) and the plugin name.
 * 2. Refuse the install when the name collides with a built-in or
 *    another external plugin already on disk.
 * 3. Extract the archive into `${PLUGINS_DIR}/<name>/`, rejecting any
 *    entry that tries to escape the destination directory.
 * 4. Dynamically `import()` the entry and verify the default export
 *    matches the manifest's name.
 * 5. Persist the install in the `Plugin` table so it can be re-loaded
 *    on the next boot, and register with the runtime `pluginRegistry`.
 *
 * Web plugins are not supported through uploads yet — the web bundle
 * is built ahead of time. Manifests with a `web` field are accepted
 * but the field is ignored for now; this leaves the door open for a
 * future loader without changing the package format.
 */
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import yauzl from 'yauzl'
import { z } from 'zod'
import { env } from '../lib/env.js'
import { prisma } from '../lib/prisma.js'
import { pluginRegistry } from './registry.js'
import type { ApiPlugin } from './types.js'

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const manifestSchema = z.object({
  name: z.string().regex(NAME_PATTERN, 'Plugin name must be kebab-case ASCII'),
  version: z.string().min(1).optional(),
  description: z.string().max(280).optional(),
  /** ESM entry, relative to the archive root. Defaults to `index.js`. */
  entry: z.string().min(1).default('index.js')
})

export type PluginManifest = z.infer<typeof manifestSchema>

export class PluginInstallError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message)
    this.name = 'PluginInstallError'
  }
}

/** Resolve and create the plugins root directory. */
async function ensurePluginsRoot(): Promise<string> {
  const root = path.resolve(env.PLUGINS_DIR)
  await mkdir(root, { recursive: true })
  return root
}

/**
 * Names that may not be used by external plugins. Built-ins reserve them;
 * `model-previewer` is the model-studio plugin's pre-rename name and stays
 * reserved so an external plugin can never inherit its legacy setting keys.
 */
const RESERVED_NAMES = new Set(['notifications', 'model-studio', 'model-previewer'])

interface ZipEntries {
  manifest: Buffer
  files: Map<string, Buffer>
}

function readZip(archivePath: string): Promise<ZipEntries> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Failed to open archive'))
        return
      }
      const files = new Map<string, Buffer>()
      let manifest: Buffer | null = null
      zip.on('error', reject)
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/')
        // Directories: skip; we recreate them when writing files.
        if (name.endsWith('/')) {
          zip.readEntry()
          return
        }
        if (name.includes('..') || name.startsWith('/')) {
          zip.close()
          reject(new PluginInstallError(`Unsafe path in archive: ${name}`))
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zip.close()
            reject(streamError ?? new Error('Failed to read entry'))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('end', () => {
            const buf = Buffer.concat(chunks)
            if (name === 'plugin.json') manifest = buf
            else files.set(name, buf)
            zip.readEntry()
          })
          stream.on('error', (readError) => {
            zip.close()
            reject(readError)
          })
        })
      })
      zip.on('end', () => {
        if (!manifest) {
          reject(new PluginInstallError('Archive is missing plugin.json'))
          return
        }
        resolve({ manifest, files })
      })
      zip.readEntry()
    })
  })
}

async function writeFiles(targetDir: string, files: Map<string, Buffer>): Promise<void> {
  for (const [name, contents] of files) {
    const filePath = path.join(targetDir, name)
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(path.resolve(targetDir) + path.sep) && resolved !== path.resolve(targetDir)) {
      throw new PluginInstallError(`Unsafe path in archive: ${name}`)
    }
    await mkdir(path.dirname(filePath), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(filePath)
      stream.write(contents)
      stream.end()
      stream.on('finish', () => resolve())
      stream.on('error', reject)
    })
  }
}

/**
 * Install a plugin from an uploaded archive. The archive file is read
 * but not mutated; callers are responsible for cleaning up the upload
 * scratch path.
 */
export async function installPluginFromArchive(archivePath: string): Promise<PluginManifest> {
  const root = await ensurePluginsRoot()
  const { manifest: manifestBuffer, files } = await readZip(archivePath)
  let manifest: PluginManifest
  try {
    manifest = manifestSchema.parse(JSON.parse(manifestBuffer.toString('utf8')))
  } catch (error) {
    throw new PluginInstallError(`Invalid plugin.json: ${(error as Error).message}`)
  }

  if (RESERVED_NAMES.has(manifest.name)) {
    throw new PluginInstallError(`Plugin name "${manifest.name}" is reserved by a built-in`)
  }

  const existingRow = await prisma.plugin.findUnique({ where: { name: manifest.name } })
  if (existingRow) {
    throw new PluginInstallError(`Plugin "${manifest.name}" is already installed; uninstall it first`)
  }
  if (pluginRegistry.get(manifest.name)) {
    throw new PluginInstallError(`Plugin name "${manifest.name}" is already in use`)
  }

  if (!files.has(manifest.entry)) {
    throw new PluginInstallError(`Manifest entry "${manifest.entry}" missing from archive`)
  }

  const installPath = path.join(root, manifest.name)
  await rm(installPath, { recursive: true, force: true })
  await mkdir(installPath, { recursive: true })
  await writeFiles(installPath, files)

  try {
    await loadAndRegister({
      name: manifest.name,
      installPath,
      entryPath: manifest.entry,
      source: 'upload'
    })
  } catch (error) {
    await rm(installPath, { recursive: true, force: true })
    throw error
  }

  await prisma.plugin.create({
    data: {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source: 'upload',
      installPath,
      entryPath: manifest.entry
    }
  })

  return manifest
}

/** Fully uninstall an external plugin: registry entry, DB row, and files. */
export async function uninstallExternalPlugin(name: string): Promise<void> {
  const row = await prisma.plugin.findUnique({ where: { name } })
  if (!row) throw new PluginInstallError(`Plugin "${name}" is not externally installed`, 404)
  await pluginRegistry.unregister(name)
  await prisma.plugin.delete({ where: { name } })
  await rm(row.installPath, { recursive: true, force: true })
}

/** Re-register every persisted external plugin. Called once at boot. */
export async function loadInstalledExternalPlugins(): Promise<void> {
  const rows = await prisma.plugin.findMany()
  for (const row of rows) {
    try {
      await loadAndRegister({
        name: row.name,
        installPath: row.installPath,
        entryPath: row.entryPath,
        source: row.source === 'store' ? 'store' : 'upload'
      })
    } catch (error) {
      console.error(`[plugin:${row.name}] failed to load`, error)
    }
  }
}

interface LoadOptions {
  name: string
  installPath: string
  entryPath: string
  source: 'upload' | 'store'
}

async function loadAndRegister(options: LoadOptions): Promise<void> {
  const entryFull = path.resolve(options.installPath, options.entryPath)
  // Cache-bust per load so a reinstall picks up new code in the same
  // process (Node caches modules by URL).
  const importUrl = pathToFileURL(entryFull).href + `?v=${Date.now()}`
  let module: { default?: unknown }
  try {
    module = await import(importUrl)
  } catch (error) {
    throw new PluginInstallError(`Failed to import plugin entry: ${(error as Error).message}`)
  }
  const candidate = module.default
  if (!isApiPlugin(candidate)) {
    throw new PluginInstallError('Plugin entry must default-export an ApiPlugin object')
  }
  if (candidate.name !== options.name) {
    throw new PluginInstallError(`Plugin name mismatch: manifest "${options.name}", export "${candidate.name}"`)
  }
  await pluginRegistry.register(candidate, { source: options.source })
}

function isApiPlugin(value: unknown): value is ApiPlugin {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.name === 'string' && typeof v.register === 'function'
}
