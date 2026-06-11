/**
 * Rebuild the standalone slicer Docker image and recreate its container.
 *
 * The dev/staging compose stacks run the slicer from a *prebuilt* image
 * (`printstream-staging-slicer:latest`) declared with `image:` and no `build:`
 * directive (see `compose.yml`). A normal `docker compose up --build` deploy only
 * rebuilds services that have a `build:` block, so it never rebakes the slicer — a
 * fix that lands in `apps/slicer/src` stays dormant in the running container until
 * its image is rebuilt by hand. This is exactly how an already-merged slicer fix can
 * appear to "regress": the source is correct but the live binary is stale.
 *
 * This script closes that gap: it `docker build`s the slicer image from
 * `apps/slicer/Dockerfile`, tags it with the canonical image name, and recreates the
 * `slicer` service from the fresh image — over SSH (matching `deploy-over-ssh.mjs`)
 * or in place with `--local`.
 *
 * Environment (shared with deploy-over-ssh.mjs):
 *   DEPLOY_SSH_HOST   Required for SSH mode unless --host is provided.
 *   DEPLOY_REPO_PATH  Required for SSH mode unless --repo-path is provided.
 *   DEPLOY_SSH_PORT   Optional SSH port.
 *   DEPLOY_SSH_KEY    Optional SSH private key.
 *   DEPLOY_PRUNE      Optional; false/0 disables the post-build dangling-image prune.
 *   SLICER_IMAGE_TAG  Optional image tag override (default printstream-staging-slicer:latest).
 *   DEPLOY_STAGING_REPO_PATH / DEPLOY_STAGING_SSH_HOST  Used when --staging is passed.
 *
 * NOTE: the build re-downloads the BambuStudio AppImage and regenerates preset
 * caches, so it takes several minutes. On a single-box setup where prod, staging, and
 * dev share one Docker daemon, the rebuilt tag is shared — rerun with the repo path of
 * each compose project that references it to recreate every slicer container.
 */
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')

const DEFAULT_IMAGE_TAG = 'printstream-staging-slicer:latest'
const SLICER_DOCKERFILE = 'apps/slicer/Dockerfile'

function parseArgs(argv) {
  const options = {
    host: process.env.DEPLOY_SSH_HOST?.trim() || undefined,
    port: process.env.DEPLOY_SSH_PORT?.trim() || undefined,
    repoPath: process.env.DEPLOY_REPO_PATH?.trim() || undefined,
    sshKeyPath: process.env.DEPLOY_SSH_KEY?.trim() || undefined,
    imageTag: process.env.SLICER_IMAGE_TAG?.trim() || DEFAULT_IMAGE_TAG,
    prune: process.env.DEPLOY_PRUNE !== '0' && process.env.DEPLOY_PRUNE !== 'false',
    local: false,
    dryRun: false
  }

  // `--staging` targets the staging instance on the same box (its own repo path/host),
  // mirroring deploy-over-ssh.mjs. Explicit flags below still override these.
  if (argv.includes('--staging')) {
    options.repoPath = process.env.DEPLOY_STAGING_REPO_PATH?.trim() || '/home/apps/printstream-staging'
    options.host = process.env.DEPLOY_STAGING_SSH_HOST?.trim() || options.host
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === '--help') {
      printHelp()
      process.exit(0)
    }

    if (argument === '--staging') continue
    if (argument === '--local') { options.local = true; continue }
    if (argument === '--dry-run') { options.dryRun = true; continue }
    if (argument === '--no-prune') { options.prune = false; continue }

    let match
    if ((match = matchFlag(argv, index, '--host'))) { options.host = match.value; index += match.consumed - 1; continue }
    if ((match = matchFlag(argv, index, '--port'))) { options.port = match.value; index += match.consumed - 1; continue }
    if ((match = matchFlag(argv, index, '--repo-path'))) { options.repoPath = match.value; index += match.consumed - 1; continue }
    if ((match = matchFlag(argv, index, '--ssh-key'))) { options.sshKeyPath = match.value; index += match.consumed - 1; continue }
    if ((match = matchFlag(argv, index, '--image-tag'))) { options.imageTag = match.value; index += match.consumed - 1; continue }

    throw new Error(`Unknown argument: ${argument}`)
  }

  return options
}

/**
 * Match a value-bearing flag in either `--flag value` or `--flag=value` form.
 * Returns `{ value, consumed }` (consumed argv slots) or null when it does not match.
 */
function matchFlag(argv, index, name) {
  const argument = argv[index]
  if (argument === name) {
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`Missing value for ${name}.`)
    return { value, consumed: 2 }
  }
  if (argument.startsWith(`${name}=`)) {
    return { value: argument.slice(name.length + 1), consumed: 1 }
  }
  return null
}

function printHelp() {
  process.stdout.write(`Usage: npm run deploy:slicer:ssh -- [options]\n\nRebuilds the slicer Docker image (${DEFAULT_IMAGE_TAG}) from ${SLICER_DOCKERFILE}\nand recreates the slicer container, which a normal deploy does not do.\n\nEnvironment:\n  DEPLOY_SSH_HOST    Required for SSH mode unless --host is provided\n  DEPLOY_REPO_PATH   Required for SSH mode unless --repo-path is provided\n  DEPLOY_SSH_PORT    Optional SSH port\n  DEPLOY_SSH_KEY     Optional SSH private key override\n  DEPLOY_PRUNE       Optional; false/0 disables the post-build dangling-image prune\n  SLICER_IMAGE_TAG   Optional image tag override (default ${DEFAULT_IMAGE_TAG})\n  DEPLOY_STAGING_REPO_PATH / DEPLOY_STAGING_SSH_HOST  Used with --staging\n\nOptions:\n  --staging          Target the staging instance's repo path / host\n  --local            Run the docker commands here instead of over SSH\n  --host <value>     SSH host (overrides DEPLOY_SSH_HOST)\n  --port <value>     SSH port override\n  --repo-path <path> Repo path holding the compose project (overrides DEPLOY_REPO_PATH)\n  --ssh-key <path>   SSH private key override\n  --image-tag <tag>  Image tag to build (overrides SLICER_IMAGE_TAG)\n  --no-prune         Skip pruning dangling images after the rebuild\n  --dry-run          Print the planned commands without running them\n  --help             Show this message\n`)
}

function requireOption(value, envName, flagName) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  throw new Error(`Missing required target. Set ${envName} or pass ${flagName} (or use --local).`)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: 'inherit'
  })

  if (result.error) throw result.error

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1)
  }
}

function buildSshBaseArgs(options) {
  const sshArgs = ['-o', 'BatchMode=yes']
  if (options.port) sshArgs.push('-p', options.port)
  if (options.sshKeyPath) sshArgs.push('-i', options.sshKeyPath)
  return sshArgs
}

/**
 * The shell program run on the target box: rebuild the slicer image from the checked
 * out source, then recreate the slicer service from it. `--force-recreate` guarantees
 * the container is replaced even if compose considers the (same-named) image
 * unchanged, so the fresh build always takes effect.
 */
function buildSlicerRebuildCommand(options) {
  const repoPath = shellQuote(options.repoPath)
  const imageTag = shellQuote(options.imageTag)
  const dockerfile = shellQuote(SLICER_DOCKERFILE)

  return [
    'set -euo pipefail',
    `cd ${repoPath}`,
    'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
    '  printf "%s %s\\n" "Building slicer from commit:" "$(git rev-parse --short HEAD)"',
    '  if [[ -n "$(git status --short --untracked-files=no -- apps/slicer)" ]]; then',
    '    printf "%s\\n" "Warning: apps/slicer has uncommitted changes; building the working tree." >&2',
    '  fi',
    'fi',
    `printf "%s %s\\n" "Rebuilding slicer image:" ${imageTag}`,
    `docker build -f ${dockerfile} -t ${imageTag} .`,
    'printf "%s\\n" "Recreating slicer container..."',
    'docker compose up -d --force-recreate slicer',
    ...(options.prune
      ? ['printf "%s\\n" "Pruning dangling images..."', 'docker image prune -f || true']
      : []),
    'docker compose ps slicer',
    'printf "%s\\n" "Recent slicer logs:"',
    'docker compose logs --tail=40 slicer || true',
    'printf "%s\\n" "Slicer image rebuilt and container recreated."'
  ].join('\n')
}

function describePlan(options, mode, sshArgs) {
  process.stdout.write(`Mode: ${mode}\n`)
  if (mode === 'ssh') {
    process.stdout.write(`Remote host: ${options.host}${options.port ? `:${options.port}` : ' (ssh config/default port)'}\n`)
  }
  process.stdout.write(`Repo path: ${options.repoPath}\n`)
  process.stdout.write(`Image tag: ${options.imageTag}\n`)
  process.stdout.write(`Will prune dangling images: ${options.prune ? 'yes' : 'no'}\n`)
  if (mode === 'ssh') {
    process.stdout.write(`SSH command: ssh ${sshArgs.map(shellQuote).join(' ')}\n`)
  } else {
    process.stdout.write(`\nCommands:\n${buildSlicerRebuildCommand(options)}\n`)
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.local) {
    options.repoPath = options.repoPath?.trim() || repoRoot
    if (options.dryRun) {
      describePlan(options, 'local')
      return
    }
    runCommand('bash', ['-lc', buildSlicerRebuildCommand(options)], { cwd: options.repoPath })
    return
  }

  options.host = requireOption(options.host, 'DEPLOY_SSH_HOST', '--host')
  options.repoPath = requireOption(options.repoPath, 'DEPLOY_REPO_PATH', '--repo-path')

  const remoteShellCommand = `bash -lc ${shellQuote(buildSlicerRebuildCommand(options))}`
  const sshArgs = buildSshBaseArgs(options)
  sshArgs.push(options.host, remoteShellCommand)

  if (options.dryRun) {
    describePlan(options, 'ssh', sshArgs)
    return
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
