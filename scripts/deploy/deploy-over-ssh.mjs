import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')

function parseArgs(argv) {
  const options = {
    branch: process.env.DEPLOY_GIT_BRANCH?.trim() || 'main',
    dryRun: false,
    host: process.env.DEPLOY_SSH_HOST?.trim() || undefined,
    port: process.env.DEPLOY_SSH_PORT?.trim() || undefined,
    push: false,
    prune: process.env.DEPLOY_PRUNE !== '0' && process.env.DEPLOY_PRUNE !== 'false',
    promoteBridgeReleases: process.env.DEPLOY_PROMOTE_BRIDGE_RELEASES !== '0' && process.env.DEPLOY_PROMOTE_BRIDGE_RELEASES !== 'false',
    bridgeReleasesDir: process.env.DEPLOY_BRIDGE_RELEASES_DIR?.trim() || 'data/bridge-releases',
    repoPath: process.env.DEPLOY_REPO_PATH?.trim() || undefined,
    skipValidate: false,
    syncBridgeReleases: process.env.DEPLOY_SYNC_BRIDGE_RELEASES === '1' || process.env.DEPLOY_SYNC_BRIDGE_RELEASES === 'true',
    sshKeyPath: process.env.DEPLOY_SSH_KEY?.trim() || undefined
  }

  // `--staging` targets the second (staging) instance on the same box: its own repo
  // path, branch, and optional host via DEPLOY_STAGING_* env vars. Explicit flags below
  // still override these. Bridge-release promotion is disabled for staging.
  if (argv.includes('--staging')) {
    options.repoPath = process.env.DEPLOY_STAGING_REPO_PATH?.trim() || '/home/apps/printstream-staging'
    options.branch = process.env.DEPLOY_STAGING_GIT_BRANCH?.trim() || options.branch
    options.host = process.env.DEPLOY_STAGING_SSH_HOST?.trim() || options.host
    options.promoteBridgeReleases = false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === '--help') {
      printHelp()
      process.exit(0)
    }

    if (argument === '--staging') {
      continue
    }

    if (argument === '--push') {
      options.push = true
      continue
    }

    if (argument === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (argument === '--skip-validate') {
      options.skipValidate = true
      continue
    }

    if (argument === '--no-prune') {
      options.prune = false
      continue
    }

    if (argument === '--sync-bridge-releases') {
      options.syncBridgeReleases = true
      continue
    }

    if (argument === '--no-promote-bridge-releases') {
      options.promoteBridgeReleases = false
      continue
    }

    if (argument === '--host') {
      const value = argv[index + 1]
      if (!value) throw new Error('Missing value for --host.')
      options.host = value
      index += 1
      continue
    }

    if (argument.startsWith('--host=')) {
      options.host = argument.slice('--host='.length)
      continue
    }

    if (argument === '--port') {
      const value = argv[index + 1]
      if (!value) throw new Error('Missing value for --port.')
      options.port = value
      index += 1
      continue
    }

    if (argument.startsWith('--port=')) {
      options.port = argument.slice('--port='.length)
      continue
    }

    if (argument === '--repo-path') {
      const value = argv[index + 1]
      if (!value) throw new Error('Missing value for --repo-path.')
      options.repoPath = value
      index += 1
      continue
    }

    if (argument.startsWith('--repo-path=')) {
      options.repoPath = argument.slice('--repo-path='.length)
      continue
    }

    if (argument === '--bridge-releases-dir') {
      const value = argv[index + 1]
      if (!value) throw new Error('Missing value for --bridge-releases-dir.')
      options.bridgeReleasesDir = value
      index += 1
      continue
    }

    if (argument.startsWith('--bridge-releases-dir=')) {
      options.bridgeReleasesDir = argument.slice('--bridge-releases-dir='.length)
      continue
    }

    if (argument === '--branch') {
      const value = argv[index + 1]
      if (!value) throw new Error('Missing value for --branch.')
      options.branch = value
      index += 1
      continue
    }

    if (argument.startsWith('--branch=')) {
      options.branch = argument.slice('--branch='.length)
      continue
    }

    if (argument === '--ssh-key') {
      const value = argv[index + 1]
      if (!value) throw new Error('Missing value for --ssh-key.')
      options.sshKeyPath = value
      index += 1
      continue
    }

    if (argument.startsWith('--ssh-key=')) {
      options.sshKeyPath = argument.slice('--ssh-key='.length)
      continue
    }

    throw new Error(`Unknown argument: ${argument}`)
  }

  return options
}

function printHelp() {
  process.stdout.write(`Usage: npm run deploy:prod:ssh -- [options]\n\nEnvironment:\n  DEPLOY_SSH_HOST       Required unless --host is provided\n  DEPLOY_REPO_PATH      Required unless --repo-path is provided\n  DEPLOY_SSH_PORT       Optional; when omitted, ssh uses its configured/default port\n  DEPLOY_GIT_BRANCH     Optional, defaults to main\n  DEPLOY_SSH_KEY        Optional SSH private key override\n  DEPLOY_PRUNE          Optional; false/0 disables post-deploy docker prune\n  DEPLOY_PROMOTE_BRIDGE_RELEASES Optional; false/0 disables tagged-release promotion\n  DEPLOY_SYNC_BRIDGE_RELEASES  Optional; true/1 syncs local bridge update artifacts\n  DEPLOY_BRIDGE_RELEASES_DIR   Optional repo-relative releases dir, defaults to data/bridge-releases\n\nOptions:\n  --push                Push local HEAD to origin/<branch> before deploying\n  --skip-validate       Skip local npm run validate before deployment\n  --no-prune            Skip pruning dangling images + old build cache after deploy\n  --no-promote-bridge-releases Disable automatic tagged-release asset promotion\n  --sync-bridge-releases Sync local bridge update artifacts before remote compose up\n  --host <value>        SSH host (overrides DEPLOY_SSH_HOST)\n  --port <value>        SSH port override\n  --repo-path <path>    Remote repo path (overrides DEPLOY_REPO_PATH)\n  --bridge-releases-dir <path> Repo-relative local and remote bridge releases directory\n  --branch <name>       Git branch to deploy, default main\n  --ssh-key <path>      Optional SSH private key override\n  --dry-run             Print the planned commands without running them\n  --help                Show this message\n`)
}

function requireOption(value, envName, flagName) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  throw new Error(`Missing required deployment target. Set ${envName} or pass ${flagName}.`)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: options.captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit'
  })

  if (result.error) throw result.error

  if ((result.status ?? 1) !== 0) {
    if (options.captureOutput) {
      const stderr = result.stderr?.trim()
      if (stderr) process.stderr.write(`${stderr}\n`)
    }

    process.exit(result.status ?? 1)
  }

  return result.stdout?.trim() ?? ''
}

function getLocalHead(ref) {
  return runCommand('git', ['rev-parse', ref], { captureOutput: true })
}

function getLocalStatus() {
  return runCommand('git', ['status', '--short'], { captureOutput: true })
}

function buildRemoteDeployCommand(options) {
  const branch = shellQuote(options.branch)
  const repoPath = shellQuote(options.repoPath)
  const bridgeReleasesDir = shellQuote(options.bridgeReleasesDir.replace(/^\.\//u, '').replace(/\/$/u, ''))

  return [
    'set -euo pipefail',
    `cd ${repoPath}`,
    'git rev-parse --is-inside-work-tree >/dev/null',
    'if [[ -n "$(git status --short --untracked-files=no)" ]]; then',
    '  printf "%s\n" "Refusing to deploy: remote repository has tracked changes." >&2',
    '  git status --short --untracked-files=no >&2',
    '  exit 1',
    'fi',
    `git fetch origin ${branch}`,
    `git checkout ${branch}`,
    `git pull --ff-only origin ${branch}`,
    ...(options.promoteBridgeReleases ? buildPromoteBridgeReleaseCommands(bridgeReleasesDir) : []),
    'export PRINTSTREAM_BRIDGE_BUILD_REVISION="$(git rev-parse --short=12 HEAD)"',
    'export BRIDGE_BUILD_REVISION="$PRINTSTREAM_BRIDGE_BUILD_REVISION"',
    'docker compose up --build -d',
    ...(options.prune ? buildPruneCommands() : []),
    'docker compose ps',
    'docker compose logs --tail=80 api',
    'printf "%s %s\n" "Deployed commit:" "$(git rev-parse --short HEAD)"'
  ].join('\n')
}

/**
 * Reclaim disk after a rebuild. `docker compose up --build` re-tags each rebuilt
 * service image and leaves the previous one untagged (dangling); build cache also
 * grows with every deploy. Left unchecked these fill the server's disk over time.
 *
 * Runs only after the new containers are up (so superseded images are dangling, not
 * in use) and prunes globally on the Docker daemon — dangling images and stale build
 * cache belong to no project, so this is safe on a box hosting both prod and staging.
 * Each step is best-effort (`|| true`): a prune hiccup must never fail a deploy whose
 * containers are already running. Disable with --no-prune or DEPLOY_PRUNE=0.
 */
function buildPruneCommands() {
  return [
    'printf "%s\n" "Pruning dangling images and build cache older than 7 days..."',
    'docker image prune -f || true',
    'docker builder prune -f --filter until=168h || true'
  ]
}

function buildPromoteBridgeReleaseCommands(bridgeReleasesDir) {
  return [
    'release_tag="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"',
    'if [[ -n "$release_tag" ]]; then',
    `  mkdir -p ${bridgeReleasesDir}`,
    '  release_version="${release_tag#v}"',
    '  release_base_url="https://github.com/RyanEwen/printstream/releases/download/${release_tag}"',
    `  curl -fsSL "\${release_base_url}/bridge-\${release_version}.zip" -o ${bridgeReleasesDir}/"bridge-\${release_version}.zip"`,
    `  curl -fsSL "\${release_base_url}/bridge-\${release_version}.release.json" -o ${bridgeReleasesDir}/"bridge-\${release_version}.release.json"`,
    '  printf "%s %s\n" "Promoted bridge update release:" "$release_tag"',
    'else',
    '  printf "%s\n" "No exact Git tag on deployed commit; skipping bridge update release promotion."',
    'fi'
  ]
}

function buildSshBaseArgs(options) {
  const sshArgs = ['-o', 'BatchMode=yes']

  if (options.port) {
    sshArgs.push('-p', options.port)
  }

  if (options.sshKeyPath) {
    sshArgs.push('-i', options.sshKeyPath)
  }

  return sshArgs
}

function syncBridgeReleaseArtifacts(options) {
  const repoRelativeDir = options.bridgeReleasesDir.replace(/^\.\//u, '').replace(/\/$/u, '')
  const localDir = path.resolve(repoRoot, repoRelativeDir)
  const remoteDir = `${options.repoPath.replace(/\/$/u, '')}/${repoRelativeDir}`
  runCommand('ssh', [...buildSshBaseArgs(options), options.host, `mkdir -p ${shellQuote(remoteDir)}`], { cwd: process.cwd() })

  const rsyncArgs = ['-az']
  if (options.port || options.sshKeyPath) {
    rsyncArgs.push('-e', ['ssh', options.port ? `-p ${options.port}` : '', options.sshKeyPath ? `-i ${shellQuote(options.sshKeyPath)}` : ''].filter(Boolean).join(' '))
  }
  rsyncArgs.push(`${localDir}/`, `${options.host}:${shellQuote(`${remoteDir}/`)}`)
  runCommand('rsync', rsyncArgs, { cwd: process.cwd() })
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  options.host = requireOption(options.host, 'DEPLOY_SSH_HOST', '--host')
  options.repoPath = requireOption(options.repoPath, 'DEPLOY_REPO_PATH', '--repo-path')
  const remoteDeployCommand = buildRemoteDeployCommand(options)
  const remoteShellCommand = `bash -lc ${shellQuote(remoteDeployCommand)}`
  const sshArgs = buildSshBaseArgs(options)

  sshArgs.push(options.host, remoteShellCommand)

  if (options.dryRun) {
    process.stdout.write(`Local repo: ${repoRoot}\n`)
    process.stdout.write(`Remote host: ${options.host}${options.port ? `:${options.port}` : ' (ssh config/default port)'}\n`)
    process.stdout.write(`Remote repo: ${options.repoPath}\n`)
    process.stdout.write(`Branch: ${options.branch}\n`)
    process.stdout.write('Compose file: compose.yml\n')
    process.stdout.write(`Will push first: ${options.push ? 'yes' : 'no'}\n`)
    process.stdout.write(`Will validate first: ${options.skipValidate ? 'no' : 'yes'}\n`)
    process.stdout.write(`Will prune dangling images + old build cache: ${options.prune ? 'yes' : 'no'}\n`)
    process.stdout.write(`Will promote tagged bridge releases: ${options.promoteBridgeReleases ? 'yes' : 'no'}\n`)
    process.stdout.write(`Will sync bridge releases: ${options.syncBridgeReleases ? 'yes' : 'no'}\n`)
    process.stdout.write(`Bridge releases dir: ${options.bridgeReleasesDir}\n`)
    process.stdout.write(`SSH command: ssh ${sshArgs.map(shellQuote).join(' ')}\n`)
    return
  }

  if (!options.skipValidate) {
    runCommand('npm', ['run', 'validate'])
  }

  runCommand('git', ['fetch', 'origin', options.branch])

  if (options.push) {
    const workingTreeStatus = getLocalStatus()

    if (workingTreeStatus) {
      throw new Error('Refusing to push before deploy: local repository has uncommitted changes.')
    }

    runCommand('git', ['push', 'origin', `HEAD:${options.branch}`])
    runCommand('git', ['fetch', 'origin', options.branch])
  }

  const localHead = getLocalHead('HEAD')
  const remoteTrackedHead = getLocalHead(`origin/${options.branch}`)

  if (localHead !== remoteTrackedHead) {
    throw new Error(`Local HEAD does not match origin/${options.branch}. Push first or rerun with --push.`)
  }

  if (options.syncBridgeReleases) {
    syncBridgeReleaseArtifacts(options)
  }

  runCommand('ssh', sshArgs, { cwd: process.cwd() })
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
