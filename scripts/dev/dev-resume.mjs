/**
 * Read-only qualification and attachment of a surviving checkout runtime.
 * Resume does not call preflight, Compose up, install, migrate, build or engine bootstrap. It owns
 * only its new host bridge and route; containers remain available after this attachment exits.
 * Counterpart: run-dev.mjs performs normal starts and explicit dev:down owns full teardown.
 */
import { spawnSync, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { writeRoute, removeRoute } from '@dynamic-solutions-canada/devkit'
import { DEV_PORTS } from '../../devkit.config.mjs'
import { hostBridgeProcessSpec, stopHostService } from './host-bridge.mjs'

const require = createRequire(import.meta.url)

/** Inspect running Docker objects privately; never print their credential-bearing environment. */
export function inspectRunningContainers({ run = spawnSync } = {}) {
  const listed = run('docker', ['ps', '--format', '{{.ID}}'], { encoding: 'utf8' })
  if (listed.status !== 0) throw new Error('cannot inspect Docker ownership; resume refused')
  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean)
  if (!ids.length) return []
  const inspected = run('docker', ['inspect', ...ids], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (inspected.status !== 0) throw new Error('cannot inspect running container ownership; resume refused')
  return JSON.parse(inspected.stdout)
}

/** Require one authentic node/database and, in remote mode, slicer; return exact node identity. */
export function qualifyDevResume(hostMode, containers, {
  repoRoot,
  remoteSlicer,
  devkitPackageRoot = path.resolve(path.dirname(require.resolve('@dynamic-solutions-canada/devkit')), '..'),
  resolvePath = realpathSync
}) {
  const databaseFiles = [
    path.join(hostMode.config.infraDir, `${hostMode.project.database.engine}.yml`),
    ...(hostMode.project.database.hostAccess ? [path.join(devkitPackageRoot, 'infra/database-host.yml')] : [])
  ].map((file) => resolvePath(file))
  const expectedFiles = [
    ...databaseFiles,
    path.join(repoRoot, 'compose.dev.yml')
  ].map((file) => resolvePath(file))
  const owned = containers.filter((item) => item.Config?.Labels?.['com.docker.compose.project'] === hostMode.identity.composeProject)
  const byService = new Map()
  for (const item of owned) {
    const labels = item.Config.Labels
    const service = labels['com.docker.compose.service']
    const files = (labels['com.docker.compose.project.config_files'] ?? '').split(',').map((file) => resolvePath(file))
    const workingDirectory = resolvePath(labels['com.docker.compose.project.working_dir'] ?? '')
    const checkoutDefinition = workingDirectory === resolvePath(repoRoot)
      && JSON.stringify(files) === JSON.stringify(expectedFiles)
    // Devkit provisions the database before app Compose up. When its config is unchanged,
    // Compose leaves that container's infra-only labels intact; this is genuine checkout ownership.
    const provisionedDatabase = service === 'database'
      && workingDirectory === resolvePath(hostMode.config.infraDir)
      && JSON.stringify(files) === JSON.stringify(databaseFiles)
    if (!['node', 'database', 'slicer'].includes(service) || byService.has(service)
      || labels['com.docker.compose.oneoff'] !== 'False'
      || (!checkoutDefinition && !provisionedDatabase)
      || item.State?.Running !== true || item.State?.Paused === true || item.State?.Restarting === true) {
      throw new Error('running Compose containers do not match this checkout; resume refused')
    }
    byService.set(service, item)
  }
  const node = byService.get('node')
  const database = byService.get('database')
  if (!node || !database || (remoteSlicer && !byService.has('slicer'))) {
    throw new Error('resume requires the surviving checkout node/database and configured slicer; use a normal start only after deliberate teardown')
  }
  if (database.State.Health?.Status !== 'healthy') throw new Error('checkout database is not healthy; resume refused')
  const project = hostMode.identity.composeProject
  const engine = hostMode.project.database.engine
  if (database.Config.Image !== `${engine}:${hostMode.project.database.version}`
    || !database.Mounts?.some((item) => item.Type === 'volume' && item.Name === `${project}-database`)
    || !database.NetworkSettings?.Networks?.[`${project}_default`]
    || !node.NetworkSettings?.Networks?.[`${project}_default`]) {
    throw new Error('database engine, volume or checkout network differs; resume refused')
  }
  const mount = node.Mounts?.find((item) => item.Destination === '/workspace')
  if (!mount || mount.Type !== 'bind' || resolvePath(mount.Source) !== resolvePath(repoRoot)
    || JSON.stringify(node.Config.Cmd) !== JSON.stringify(['node', 'scripts/dev/run-dev.mjs', '--container-runtime'])) {
    throw new Error('node runtime source or command differs from this checkout; resume refused')
  }
  const environment = new Map((node.Config.Env ?? []).map((entry) => {
    const equals = entry.indexOf('=')
    return [entry.slice(0, equals), entry.slice(equals + 1)]
  }))
  if (environment.get('PRINTSTREAM_DEV_BRIDGE') !== 'host'
    || environment.get('DEVKIT_COMPOSE_PROJECT') !== hostMode.identity.composeProject) {
    throw new Error('surviving node has another bridge/checkout configuration; resume refused')
  }
  for (const name of ['web', 'api']) {
    const internal = `${DEV_PORTS[name]}/tcp`
    const assigned = String(hostMode.ports[name])
    const bindings = node.NetworkSettings?.Ports?.[internal] ?? []
    if (!bindings.length || !bindings.some((binding) => binding.HostIp === '127.0.0.1')
      || bindings.some((binding) => !['127.0.0.1', '::1'].includes(binding.HostIp) || binding.HostPort !== assigned)) {
      throw new Error(`surviving node does not own the exact loopback ${name} port; resume refused`)
    }
    const foreign = containers.some((item) => item.Id !== node.Id && Object.values(item.NetworkSettings?.Ports ?? {})
      .some((entries) => entries?.some((binding) => binding.HostPort === assigned)))
    if (foreign) throw new Error(`another container also publishes ${name} ${assigned}; resume refused`)
  }
  return { nodeId: node.Id }
}

/** Attach without recreating services; stop only the bridge we spawned, never adopted containers. */
export async function runDevResume(hostMode, qualified, { repoRoot, runtime = { spawn, process }, route = { writeRoute, removeRoute } } = {}) {
  let bridge
  let logs
  let routeWritten = false
  let requestedShutdown = null
  const handlers = new Map()
  try {
    bridge = runtime.spawn(...bridgeArgs(hostMode, repoRoot))
    await waitForSpawn(bridge)
    route.writeRoute(hostMode.config, hostMode.identity, hostMode.ports.web)
    routeWritten = true
    console.log(`[dev] resumed ${hostMode.url}; existing containers and slicer are unchanged`)
    logs = runtime.spawn('docker', ['logs', '--follow', '--tail', '30', qualified.nodeId], { stdio: 'inherit' })
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        requestedShutdown ??= signal
        logs.kill(signal)
      }
      handlers.set(signal, handler)
      runtime.process.once(signal, handler)
    }
    // A bridge failure must end the attachment visibly instead of leaving a healthy-looking route.
    bridge.once('exit', () => logs.kill('SIGTERM'))
    return await new Promise((resolve, reject) => {
      logs.once('error', reject)
      logs.once('exit', (code) => {
        if (requestedShutdown) {
          resolve({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[requestedShutdown])
          return
        }
        // docker logs can exit zero when a container stops. This launcher is supposed to keep
        // serving, so lost attachment or bridge exit is failure even with a clean Docker exit.
        resolve(code && code !== 0 ? code : 1)
      })
    })
  } finally {
    for (const [signal, handler] of handlers) runtime.process.removeListener(signal, handler)
    if (logs?.exitCode === null && logs.signalCode === null) logs.kill('SIGTERM')
    await stopHostService(bridge)
    if (routeWritten) route.removeRoute(hostMode.config, hostMode.identity)
  }
}

function bridgeArgs(hostMode, repoRoot) {
  const spec = hostBridgeProcessSpec({ repoRoot, apiPort: hostMode.ports.api })
  return [spec.command, spec.args, spec.options]
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}
