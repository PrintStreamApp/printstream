/**
 * Builds the process specification for the development bridge that runs on the host beside a
 * Devkit Compose stack. Docker Desktop cannot route this machine's container networks to the
 * printer LAN, so the bridge is the deliberate host-side exception. Its server URL uses the
 * checkout's derived API port, which keeps parallel worktrees isolated.
 */
import path from 'node:path'

/** Return the direct Node supervisor command for one worktree's host bridge. */
export function hostBridgeProcessSpec({
  repoRoot,
  apiPort,
  env = process.env,
  execPath = process.execPath
}) {
  const bridgeDir = path.join(repoRoot, 'apps', 'bridge')
  const supervisor = path.join(repoRoot, 'scripts', 'dev', 'run-service-dev.mjs')
  const exitWithParent = path.join(repoRoot, 'scripts', 'dev', 'exit-with-parent.cjs')
  const nodeOptions = [env.NODE_OPTIONS, '--require', exitWithParent].filter(Boolean).join(' ')

  return {
    command: execPath,
    args: [
      supervisor,
      '--name=bridge',
      '--entry=src/index.ts',
      '--env-file=../../.env',
      '--watch=src',
      '--watch=../../packages/shared/dist',
      '--watch=../../packages/bridge-runtime/dist'
    ],
    options: {
      cwd: bridgeDir,
      stdio: 'inherit',
      env: {
        ...env,
        NODE_OPTIONS: nodeOptions,
        BRIDGE_SERVER_URL: `http://127.0.0.1:${apiPort}`
      }
    }
  }
}

/** Stop a supervised host service and wait briefly for its own graceful child cleanup. */
export async function stopHostService(child, { timeoutMs = 3_000, warn = console.warn } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')

  let timeout
  await Promise.race([
    exited,
    new Promise((resolve) => { timeout = setTimeout(resolve, timeoutMs) })
  ])
  clearTimeout(timeout)

  if (child.exitCode === null && child.signalCode === null) {
    warn(`[dev] host bridge did not stop within ${timeoutMs}ms; forcing it to exit`)
    child.kill('SIGKILL')
  }
}
