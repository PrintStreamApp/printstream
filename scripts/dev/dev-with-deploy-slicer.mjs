/**
 * Runs the normal local dev stack while tunneling slicer traffic to the
 * deploy host's private slicer service.
 */
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const tunnelPort = Number(process.env.DEV_DEPLOY_SLICER_LOCAL_PORT || '4010')
const remoteSlicerPort = Number(process.env.SLICER_BIND_PORT || '4010')

const deployHost = process.env.DEPLOY_SSH_HOST?.trim()
if (!deployHost) {
  throw new Error('DEPLOY_SSH_HOST is required to run the deploy slicer helper.')
}

const deployRepoPath = process.env.DEPLOY_REPO_PATH?.trim()
if (!deployRepoPath) {
  throw new Error('DEPLOY_REPO_PATH is required to read the deploy slicer configuration.')
}

const slicerToken = await resolveSlicerToken()

const configuredUrl = process.env.SLICER_SERVICE_URL?.trim()
const expectedUrl = `http://127.0.0.1:${tunnelPort}`
if (configuredUrl && configuredUrl !== expectedUrl) {
  process.stdout.write(`Using deploy slicer tunnel URL ${expectedUrl} instead of configured SLICER_SERVICE_URL ${configuredUrl}.\n`)
}

await ensurePortAvailable(tunnelPort)

const tunnel = startTunnel({ host: deployHost, localPort: tunnelPort, remotePort: remoteSlicerPort })

try {
  await waitForTunnelReady(tunnelPort)
  process.stdout.write(`Deploy slicer tunnel ready at ${expectedUrl}.\n`)
  const dev = spawn('npm', ['run', 'dev'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SLICER_SERVICE_URL: expectedUrl,
      ...(slicerToken ? { SLICER_SERVICE_TOKEN: slicerToken } : {})
    },
    stdio: 'inherit'
  })

  const forwardSignal = (signal) => {
    if (!dev.killed) dev.kill(signal)
  }

  process.once('SIGINT', forwardSignal)
  process.once('SIGTERM', forwardSignal)

  const exitCode = await new Promise((resolve, reject) => {
    dev.once('error', reject)
    dev.once('exit', (code, signal) => {
      if (signal) {
        resolve(1)
        return
      }
      resolve(code ?? 0)
    })
  })

  process.exitCode = exitCode
} finally {
  stopProcess(tunnel)
}

function startTunnel({ host, localPort, remotePort }) {
  const sshArgs = buildSshArgs({ batchMode: true })

  sshArgs.push('-N', '-L', `${localPort}:127.0.0.1:${remotePort}`, host)

  const child = spawn('ssh', sshArgs, {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit']
  })

  child.once('exit', (code) => {
    if (process.exitCode == null && code && code !== 0) {
      process.exitCode = code
    }
  })

  return child
}

async function resolveSlicerToken() {
  const localToken = process.env.SLICER_SERVICE_TOKEN?.trim()
  if (localToken) return localToken

  const sshArgs = buildSshArgs({ batchMode: true })
  const remoteCommand = `cd ${shellQuote(deployRepoPath)} && awk -F= '/^SLICER_SERVICE_TOKEN=/ { print substr($0, index($0,$2)); exit }' .env`
  const child = spawn('ssh', [...sshArgs, deployHost, remoteCommand], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit']
  })

  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })

  const [exitCode] = await once(child, 'exit')
  if ((exitCode ?? 1) !== 0) {
    throw new Error('Failed to read SLICER_SERVICE_TOKEN from the deploy host. Set it locally or verify deploy SSH access.')
  }

  return stdout.trim() || undefined
}

function buildSshArgs({ batchMode }) {
  const sshArgs = []
  if (batchMode) sshArgs.push('-o', 'BatchMode=yes')
  sshArgs.push('-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3')

  const deployPort = process.env.DEPLOY_SSH_PORT?.trim()
  if (deployPort) sshArgs.push('-p', deployPort)

  const deployKey = process.env.DEPLOY_SSH_KEY?.trim()
  if (deployKey) sshArgs.push('-i', deployKey)

  return sshArgs
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

async function ensurePortAvailable(port) {
  const available = await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })

  if (!available) {
    throw new Error(`Local port ${port} is already in use. Stop the existing tunnel or set DEV_DEPLOY_SLICER_LOCAL_PORT.`)
  }
}

async function waitForTunnelReady(port) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const reachable = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.end()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
    })

    if (reachable) return
    await delay(250)
  }

  throw new Error(`Timed out waiting for local slicer tunnel on 127.0.0.1:${port}.`)
}

function stopProcess(child) {
  if (!child || child.killed) return
  child.kill('SIGTERM')
}