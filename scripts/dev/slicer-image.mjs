/**
 * Whether the containerised dev slicer is running something current.
 *
 * The gap this exists to close: `docker compose up -d` pulls an image only when it is ABSENT, so
 * once a machine has `printstream-slicer:latest` it keeps that exact digest forever. A newer engine,
 * or a fix to the slicer, reaches everyone who has never pulled again as nothing at all: the
 * container keeps starting, keeps answering /health, and keeps slicing with the old build. There is
 * no error to notice, which is why this has to be something you can ASK.
 *
 * Reports, never repairs, matching `doctor.mjs`: pulling ~600 MB is not something a diagnostic
 * should decide to do. Every answer names the command that acts on it.
 *
 * Two different kinds of "out of date" are worth separating, because the fixes differ:
 *   - the RELEASED image moved on          -> `docker compose -f compose.dev.yml pull slicer`
 *   - your checkout's slicer source differs -> the container cannot contain your changes at all;
 *     build your own (see compose.dev.yml) or use the in-process slicer.
 *
 * Counterpart: the `slicer` service in `compose.dev.yml`. The image reference is read off the
 * RUNNING container rather than duplicated here, so the two cannot drift.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Repo paths whose contents change what the slicer image DOES, per `apps/slicer/Dockerfile`: the
 * build recipe and context rules, dependency/compiler inputs, service, docker helpers baked in
 * beside it, and the shared package it imports.
 *
 * Narrower than the Dockerfile's broad directory copies deliberately: guidance, tests and licence
 * notices can change bytes in an intermediate build context without changing the runnable image.
 * Configuration and lockfiles stay in because they can change emitted code or the installed
 * dependency graph even when no TypeScript source moved.
 */
const IMAGE_SOURCE_PATHS = [
  '.dockerignore',
  'apps/slicer/Dockerfile',
  'apps/slicer/src',
  'apps/slicer/docker',
  'apps/slicer/package.json',
  'apps/slicer/tsconfig.json',
  'package.json',
  'package-lock.json',
  'packages/shared/src',
  'packages/shared/package.json',
  'packages/shared/tsconfig.json',
  'tsconfig.base.json'
]

const SERVICE = 'slicer'
const SOURCE_FINGERPRINT_LABEL = 'io.printstream.dev.source-fingerprint'

function dockerCli(args, { timeoutMs = 15_000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs })
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  }
}

function gitCli(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 })
  return { ok: result.status === 0, stdout: (result.stdout || '').trim() }
}

/**
 * Returns a stable digest of every tracked or unignored slicer build input in the checkout.
 *
 * File paths are included so equal bytes moved between files still change the result. Missing
 * tracked files are represented explicitly, which makes an uncommitted deletion invalidate the
 * image too. Null means Git could not enumerate the checkout safely.
 */
export function slicerSourceFingerprint(repoRoot, { git = gitCli, read = readFileSync } = {}) {
  const listed = git(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...IMAGE_SOURCE_PATHS],
    repoRoot
  )

  if (!listed.ok) {
    return null
  }

  const files = listed.stdout.split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')

  for (const file of files) {
    hash.update(file)
    hash.update('\0')

    try {
      hash.update(read(path.join(repoRoot, file)))
    } catch {
      hash.update('<missing>')
    }

    hash.update('\0')
  }

  return hash.digest('hex')
}

/** The container id of this checkout's slicer, or null when it is not running. */
function runningContainerId(docker, composeProject) {
  const found = docker([
    'ps', '--quiet',
    '--filter', `label=com.docker.compose.project=${composeProject}`,
    '--filter', `label=com.docker.compose.service=${SERVICE}`
  ])
  return found.ok && found.stdout ? found.stdout.split('\n')[0] : null
}

/**
 * Digest of the image the registry serves for that tag, or null when it cannot be asked.
 *
 * Must be the INDEX digest, which is what a pulled multi-arch image records as its RepoDigest.
 * `docker manifest inspect --verbose` looks like the obvious source and is the wrong one: for a
 * manifest list it returns one entry PER PLATFORM, each carrying that platform's own manifest
 * digest, so comparing the first entry reports every multi-arch image as stale forever. (Measured:
 * the arm64 entry reads 86decba... for a tag whose index is 431d791..., which is what the local image
 * actually records.) `imagetools inspect` reports the index digest directly.
 *
 * Null is deliberately indistinguishable from "no network": an unreachable registry must read as
 * UNKNOWN rather than as up to date, or the check quietly stops meaning anything offline.
 */
function registryDigest(docker, imageRef) {
  const inspected = docker(
    ['buildx', 'imagetools', 'inspect', imageRef, '--format', '{{.Manifest.Digest}}'],
    { timeoutMs: 20_000 }
  )
  const digest = inspected.ok ? inspected.stdout.split('\n').pop()?.trim() : null
  return digest && digest.startsWith('sha256:') ? digest : null
}

/**
 * Whether a reference points at a registry at all, by Docker's own rule: the first segment is a host
 * when it carries a dot or a port. `ghcr.io/printstreamapp/x` does; `printstream-slicer-dev` does
 * not, and asking a registry about it is meaningless rather than merely offline.
 */
function isRegistryReference(imageRef) {
  const [first] = imageRef.split('/')
  return imageRef.includes('/') && (first.includes('.') || first.includes(':'))
}

/**
 * Inspects the checkout's slicer container and compares what it runs against the registry.
 *
 * Never throws: a machine with no Docker, no container, or no network still gets a readout.
 *
 * `run` is injectable so the state machine is testable without a daemon, a registry, or a 600 MB
 * pull; nothing else should pass it.
 */
export function inspectSlicerImage({
  run = dockerCli,
  composeProject = process.env.COMPOSE_PROJECT_NAME || 'printstream'
} = {}) {
  const docker = run
  const container = runningContainerId(docker, composeProject)
  if (!container) return { state: 'not-running' }

  const image = docker(['inspect', container, '--format', '{{.Config.Image}}'])
  const imageRef = image.ok ? image.stdout : null
  if (!imageRef) return { state: 'unknown', reason: 'could not read the container image' }

  // Decided from the REFERENCE, not from the absence of a RepoDigest. "A local build has no
  // RepoDigest" is the obvious rule and is false on Docker Desktop's containerd image store, which
  // gives one to locally built images too (`printstream-slicer-dev@sha256:...`): the check then
  // asked a registry about a name that was never in one and reported "could not be reached" for the
  // default setup. A reference names a registry only when its first segment looks like a host.
  if (!isRegistryReference(imageRef)) return { state: 'local-build', imageRef }

  const digests = docker(['image', 'inspect', imageRef, '--format', '{{join .RepoDigests ","}}'])
  const localDigest = digests.ok && digests.stdout ? digests.stdout.split(',')[0].split('@')[1] : null
  if (!localDigest) return { state: 'local-build', imageRef }

  const remote = registryDigest(docker, imageRef)
  if (!remote) return { state: 'unknown', imageRef, reason: 'the registry could not be reached' }

  return {
    state: remote === localDigest ? 'current' : 'stale',
    imageRef,
    localDigest,
    remoteDigest: remote
  }
}

/**
 * Whether the checkout's local image can actually contain this checkout's slicer code.
 *
 * The failure this exists to name: editing `apps/slicer` changes NOTHING about a container running
 * the published image, and nothing says so. The slice succeeds, against the old build, so the
 * result looks like your change had no effect rather than like it was never there. That reads as a
 * bug in the code you just wrote, which is the worst possible place to send someone.
 *
 * Local dev images carry a content fingerprint of every build-affecting input. This avoids both
 * Git-lineage ambiguity and Docker's reproducible-build timestamp trap: a fully cached build can
 * recreate the same old image timestamp even though the build just succeeded. Older images without
 * the label fall back to source age once, then acquire a fingerprint on their migration build.
 */
export function inspectSlicerSource({
  repoRoot,
  run = dockerCli,
  git = gitCli,
  stat = statSync,
  composeProject = process.env.COMPOSE_PROJECT_NAME || 'printstream',
  imageRef: configuredImageRef = null,
  sourceFingerprint = slicerSourceFingerprint(repoRoot, { git })
} = {}) {
  const container = runningContainerId(run, composeProject)

  // `.Config.Image` is the reference the container was created from, not `.Image` (the resolved
  // id): under Docker Desktop's containerd image store that id does not inspect as an image at all,
  // so the lookup failed and every answer came back "unknown".
  // A stopped Devkit checkout has no container because teardown runs `compose down`, but its image
  // remains. Falling back to the configured checkout image is load-bearing: treating no container
  // as no image caused every following launch to rebuild the already-current slicer.
  const image = container
    ? run(['inspect', container, '--format', '{{.Config.Image}}'])
    : { ok: Boolean(configuredImageRef), stdout: configuredImageRef || '' }
  const imageRef = image.ok ? image.stdout.trim() : ''

  if (!imageRef) {
    return { state: 'not-running' }
  }

  // Docker can reuse every build layer and reproduce an older image config exactly. Its `.Created`
  // timestamp then remains older than recently touched source even after a successful build, which
  // made every launch rebuild forever. New local images carry the exact source digest instead.
  const label = run([
    'image',
    'inspect',
    imageRef,
    '--format',
    `{{index .Config.Labels "${SOURCE_FINGERPRINT_LABEL}"}}`
  ])
  const builtFingerprint = label.ok ? label.stdout.trim() : ''

  if (sourceFingerprint && builtFingerprint && builtFingerprint !== '<no value>') {
    if (sourceFingerprint === builtFingerprint) {
      return { state: 'matches' }
    }

    return {
      state: 'differs',
      reason: 'this checkout\'s slicer source differs from the local image'
    }
  }

  // Existing images predate the fingerprint label. Keep the timestamp fallback so they only need
  // one migration build, after which all future checks use content rather than modification time.
  const created = imageRef ? run(['image', 'inspect', imageRef, '--format', '{{.Created}}']) : { ok: false, stdout: '' }
  const builtAt = created.ok ? Date.parse(created.stdout.trim()) : Number.NaN

  if (!Number.isFinite(builtAt)) {
    if (!container && configuredImageRef) {
      return { state: 'not-built', imageRef: configuredImageRef }
    }

    return { state: 'unknown', reason: 'the image records no build time' }
  }

  // Committed changes and uncommitted ones both count: the question is what is on disk now, not
  // what has been recorded. `git log -1` covers the former, file mtimes the latter.
  const lastCommit = git(['log', '-1', '--format=%cI', '--', ...IMAGE_SOURCE_PATHS], repoRoot)
  const committedAt = lastCommit.ok && lastCommit.stdout ? Date.parse(lastCommit.stdout) : Number.NaN

  const dirty = git(['status', '--porcelain', '--', ...IMAGE_SOURCE_PATHS], repoRoot)
  const hasUncommitted = dirty.ok && dirty.stdout.length > 0

  if (hasUncommitted) {
    // Name what changed, not where it looked: "under apps/slicer/src and apps/slicer/docker and
    // …" tells you the search paths, which you already knew, and not the answer.
    // Not a fixed offset: the runner trims stdout, so the porcelain status column is 2 chars on
    // the first line and 3 (leading space intact) on the rest. Strip the code, whatever its width.
    const changed = dirty.stdout.split('\n').map((line) => line.trim().replace(/^\S{1,2}\s+/, '')).filter(Boolean)
    const shown = changed.slice(0, 3).join(', ')
    // Dirty does not itself mean stale: a local build is EXPECTED to contain dirty source. Compare
    // those files' mtimes with the image creation time so a successful rebuild becomes current on
    // the very next start. The old unconditional return rebuilt the identical image forever until
    // the developer committed. A missing path (an uncommitted deletion) stays conservative because
    // there is no file timestamp proving when the deletion happened.
    const dirtyIsNewer = changed.some((file) => {
      try {
        return stat(path.join(repoRoot, file)).mtimeMs > builtAt
      } catch {
        return true
      }
    })
    if (dirtyIsNewer) {
      return {
        state: 'differs',
        reason: `uncommitted ${shown}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}`
      }
    }
  }
  if (!Number.isFinite(committedAt)) return { state: 'unknown', reason: 'could not read the last slicer commit' }
  if (committedAt > builtAt) {
    return { state: 'differs', reason: `this checkout's slicer source is newer than the image (built ${new Date(builtAt).toISOString().slice(0, 10)})` }
  }
  return { state: 'matches' }
}
