/**
 * Bridge runner launcher.
 *
 * Starts a signed app bundle from the bridge-owned releases directory when one
 * is activated, otherwise falls back to the image-bundled runtime entrypoint.
 */
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'

interface ActiveBridgeReleasePointer {
  releasePath: string
  entrypoint: string
  activatedAt?: string
  confirmedAt?: string
  pendingHealthCheck?: boolean
}

export async function resolveActiveBridgeEntrypoint(releasesDir: string): Promise<string | null> {
  const pointer = await readActiveReleasePointer(releasesDir)
  if (!pointer) return null

  const releasePath = resolveSafeChildPath(releasesDir, pointer.releasePath)
  const entrypoint = resolveSafeChildPath(releasePath, pointer.entrypoint)
  await access(entrypoint)
  return entrypoint
}

export async function restorePreviousBridgeRelease(releasesDir: string): Promise<boolean> {
  const previousPath = path.join(releasesDir, 'previous.json')
  const currentPath = path.join(releasesDir, 'current.json')
  const previous = await readFile(previousPath, 'utf8').catch(() => null)
  if (!previous) return false
  await writeFile(currentPath, previous, 'utf8')
  return true
}

export async function isActiveBridgeReleasePendingHealthCheck(releasesDir: string): Promise<boolean> {
  return (await readActiveReleasePointer(releasesDir))?.pendingHealthCheck === true
}

export async function confirmActiveBridgeReleaseHealthy(releasesDir: string, version: string): Promise<boolean> {
  const currentPath = path.join(releasesDir, 'current.json')
  const pointer = await readActiveReleasePointer(releasesDir)
  if (!pointer || pointer.releasePath !== version || pointer.pendingHealthCheck !== true) return false
  await writeFile(currentPath, JSON.stringify({
    ...pointer,
    pendingHealthCheck: false,
    confirmedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8')
  return true
}

export async function cleanupConfirmedBridgeReleases(input: {
  releasesDir: string
  retentionMs: number
  now?: Date
}): Promise<string[]> {
  const pointer = await readActiveReleasePointer(input.releasesDir)
  if (!pointer?.confirmedAt || pointer.pendingHealthCheck === true) return []
  const confirmedAt = Date.parse(pointer.confirmedAt)
  if (!Number.isFinite(confirmedAt)) return []
  const nowMs = input.now?.getTime() ?? Date.now()
  if (nowMs - confirmedAt < input.retentionMs) return []

  const removed: string[] = []
  const entries = await readdir(input.releasesDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.staging' || entry.name === pointer.releasePath) continue
    await rm(path.join(input.releasesDir, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  if (removed.length > 0) {
    await rm(path.join(input.releasesDir, 'previous.json'), { force: true })
  }
  return removed
}

async function readActiveReleasePointer(releasesDir: string): Promise<ActiveBridgeReleasePointer | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(releasesDir, 'current.json'), 'utf8')) as Partial<ActiveBridgeReleasePointer>
    if (typeof parsed.releasePath !== 'string' || typeof parsed.entrypoint !== 'string') return null
    return {
      releasePath: parsed.releasePath,
      entrypoint: parsed.entrypoint,
      ...(typeof parsed.activatedAt === 'string' ? { activatedAt: parsed.activatedAt } : {}),
      ...(typeof parsed.confirmedAt === 'string' ? { confirmedAt: parsed.confirmedAt } : {}),
      ...(typeof parsed.pendingHealthCheck === 'boolean' ? { pendingHealthCheck: parsed.pendingHealthCheck } : {})
    }
  } catch {
    return null
  }
}

function resolveSafeChildPath(root: string, child: string): string {
  if (path.isAbsolute(child)) {
    throw new Error('Bridge release pointer cannot use absolute paths.')
  }
  const resolved = path.resolve(root, child)
  const normalizedRoot = path.resolve(root)
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Bridge release pointer cannot escape the releases directory.')
  }
  return resolved
}

async function main(): Promise<void> {
  let rollbackAttempted = false
  while (true) {
    const activeEntrypoint = await resolveActiveBridgeEntrypoint(env.BRIDGE_RELEASES_DIR).catch((error) => {
      console.warn(`Ignoring active bridge release pointer: ${(error as Error).message}`)
      return null
    })
    const fallbackEntrypoint = fileURLToPath(new URL('./index.js', import.meta.url))
    const entrypoint = activeEntrypoint ?? fallbackEntrypoint
    const result = await runBridgeEntrypoint(entrypoint, activeEntrypoint ? await readActiveBridgeReleaseEnv(env.BRIDGE_RELEASES_DIR, activeEntrypoint) : {})
    if (result.signal) {
      process.kill(process.pid, result.signal)
      return
    }
    if (activeEntrypoint && result.code !== 0 && !rollbackAttempted && await isActiveBridgeReleasePendingHealthCheck(env.BRIDGE_RELEASES_DIR) && await restorePreviousBridgeRelease(env.BRIDGE_RELEASES_DIR)) {
      rollbackAttempted = true
      console.warn('Bridge release failed before health confirmation; restored previous release pointer and retrying once.')
      continue
    }
    process.exit(result.code ?? 0)
  }
}

async function readActiveBridgeReleaseEnv(releasesDir: string, entrypoint: string): Promise<Record<string, string>> {
  const relative = path.relative(path.resolve(releasesDir), entrypoint)
  const [releasePath] = relative.split(path.sep)
  if (!releasePath || releasePath.startsWith('..')) return {}
  const manifest = await readFile(path.join(releasesDir, releasePath, 'manifest.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { version?: unknown; protocolVersion?: unknown; runnerAbiVersion?: unknown })
    .catch(() => null)
  if (!manifest) return {}

  return {
    ...(typeof manifest.version === 'string' ? { BRIDGE_VERSION: manifest.version } : {}),
    ...(typeof manifest.protocolVersion === 'number' ? { BRIDGE_PROTOCOL_VERSION: String(manifest.protocolVersion) } : {}),
    ...(typeof manifest.runnerAbiVersion === 'string' ? { BRIDGE_RUNNER_ABI_VERSION: manifest.runnerAbiVersion } : {})
  }
}

function runBridgeEntrypoint(entrypoint: string, extraEnv: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = spawn(process.execPath, [entrypoint], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error('Bridge launcher failed', error)
    process.exit(1)
  })
}