import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  inspectSlicerImage,
  inspectSlicerSource,
  slicerComposeUpArgs,
  slicerDevImageRef,
  slicerSourceFingerprint
} from './slicer-image.mjs'

const CONTAINER = 'abc123'
const IMAGE = 'ghcr.io/printstreamapp/printstream-slicer:latest'
const INDEX_DIGEST = 'sha256:431d791cdab52609bc7322ea016956f610da11c9f97df28ade4d0ae0f1ba802d'
const PLATFORM_DIGEST = 'sha256:86decba0cde9357469fea295ed7db28d888903b5db42cf5f71c9b2f83b15437a'

/**
 * A fake `docker` that answers each call by what it is asking for, so a test states only the facts
 * it cares about. Anything unstubbed answers as a failure, which is what an absent daemon does.
 */
function fakeDocker({ containerId = CONTAINER, image = IMAGE, repoDigests, registry } = {}) {
  return (args) => {
    const joined = args.join(' ')
    if (joined.startsWith('ps ')) return { ok: true, stdout: containerId ?? '', stderr: '' }
    if (joined.startsWith(`inspect ${CONTAINER}`)) return { ok: true, stdout: image, stderr: '' }
    if (joined.startsWith('image inspect')) {
      return repoDigests === undefined
        ? { ok: true, stdout: `${IMAGE}@${INDEX_DIGEST}`, stderr: '' }
        : { ok: true, stdout: repoDigests, stderr: '' }
    }
    if (joined.startsWith('buildx imagetools')) {
      return registry === null
        ? { ok: false, stdout: '', stderr: 'no such host' }
        : { ok: true, stdout: registry ?? INDEX_DIGEST, stderr: '' }
    }
    return { ok: false, stdout: '', stderr: 'unexpected call' }
  }
}

test('a matching index digest reads as current', () => {
  assert.equal(inspectSlicerImage({ run: fakeDocker() }).state, 'current')
})

test('a moved tag reads as stale', () => {
  const result = inspectSlicerImage({ run: fakeDocker({ registry: `sha256:${'0'.repeat(64)}` }) })
  assert.equal(result.state, 'stale')
})

// The bug this pins: `docker manifest inspect --verbose` answers with the per-PLATFORM manifest
// digest, which never equals the index digest a pulled multi-arch image records, so reading the
// registry that way reports every such image as stale forever. The comparison must be index to
// index; a platform digest arriving here is a wrong-source regression, not a real difference.
test('a platform digest is never mistaken for the index digest', () => {
  const result = inspectSlicerImage({ run: fakeDocker({ registry: PLATFORM_DIGEST }) })
  assert.equal(result.state, 'stale')
  assert.notEqual(result.remoteDigest, result.localDigest)
})

test('no container reads as not-running rather than as a problem', () => {
  assert.equal(inspectSlicerImage({ run: fakeDocker({ containerId: '' }) }).state, 'not-running')
})

test('a custom compose project selects its own slicer container', () => {
  let psArgs = []
  const run = (args) => {
    if (args[0] === 'ps') psArgs = args
    return fakeDocker()(args)
  }
  inspectSlicerImage({ run, composeProject: 'custom-project' })
  assert.ok(psArgs.includes('label=com.docker.compose.project=custom-project'))
})

test('an image with no RepoDigest is a local build, not a staleness question', () => {
  assert.equal(inspectSlicerImage({ run: fakeDocker({ repoDigests: '' }) }).state, 'local-build')
})

// The bug this pins: Docker Desktop's containerd image store gives locally built images a
// RepoDigest too, so "no RepoDigest" does not identify them. A local tag must be recognised from
// its REFERENCE, or the default build-from-source setup asks a registry about a name that was never
// in one and reports the answer as "registry unreachable".
test('a local tag is a local build even when it carries a RepoDigest', () => {
  const run = fakeDocker({ repoDigests: 'printstream-slicer-dev@' + INDEX_DIGEST })
  const withLocalTag = (args) => (args.join(' ').startsWith(`inspect ${CONTAINER}`)
    ? { ok: true, stdout: 'printstream-slicer-dev', stderr: '' }
    : run(args))
  assert.equal(inspectSlicerImage({ run: withLocalTag }).state, 'local-build')
})

// Offline must not read as up to date: that would make the check quietly stop meaning anything
// exactly when it cannot answer.
test('an unreachable registry reads as unknown', () => {
  assert.equal(inspectSlicerImage({ run: fakeDocker({ registry: null }) }).state, 'unknown')
})


/**
 * `inspectSlicerSource` answers "could my edits be in the running container?", so its fixtures are a
 * build time and a working tree, not digests.
 */
function fakeSourceDocker({
  containerId = CONTAINER,
  created = '2026-09-01T00:00:00Z',
  fingerprint = null
} = {}) {
  return (args) => {
    const joined = args.join(' ')
    if (joined.startsWith('ps ')) return { ok: true, stdout: containerId ?? '', stderr: '' }
    // The reference, not the resolved id: see the note in the module.
    if (joined.includes('.Config.Image')) return { ok: true, stdout: 'printstream-slicer-dev', stderr: '' }
    if (joined.includes('source-fingerprint')) {
      return { ok: true, stdout: fingerprint || '<no value>', stderr: '' }
    }
    if (joined.startsWith('image inspect')) {
      return created === null ? { ok: false, stdout: '', stderr: 'no such image' } : { ok: true, stdout: created, stderr: '' }
    }
    return { ok: false, stdout: '', stderr: 'unexpected call' }
  }
}

test('the slicer source fingerprint is stable across file enumeration order', () => {
  const files = new Map([
    ['/repo/apps/slicer/src/index.ts', Buffer.from('slicer')],
    ['/repo/package.json', Buffer.from('{"name":"printstream"}')]
  ])
  const read = (file) => files.get(file)
  const first = slicerSourceFingerprint('/repo', {
    git: () => ({ ok: true, stdout: 'package.json\0apps/slicer/src/index.ts\0' }),
    read
  })
  const second = slicerSourceFingerprint('/repo', {
    git: () => ({ ok: true, stdout: 'apps/slicer/src/index.ts\0package.json\0' }),
    read
  })

  assert.equal(first, second)
})

test('a matching source fingerprint wins over an old image timestamp', () => {
  const fingerprint = 'current-source'
  const result = inspectSlicerSource({
    repoRoot: '/repo',
    run: fakeSourceDocker({ fingerprint }),
    git: fakeGit({ dirty: ' M apps/slicer/src/index.ts' }),
    stat: () => ({ mtimeMs: Date.parse('2026-09-10T00:00:00Z') }),
    sourceFingerprint: fingerprint
  })

  assert.equal(result.state, 'matches')
})

test('a changed source fingerprint requires a rebuild', () => {
  const result = inspectSlicerSource({
    repoRoot: '/repo',
    run: fakeSourceDocker({ fingerprint: 'built-source' }),
    git: fakeGit(),
    sourceFingerprint: 'current-source'
  })

  assert.equal(result.state, 'differs')
})

test('dev slicer images are shared only when their source fingerprints match', () => {
  assert.equal(
    slicerDevImageRef('same-content', 'checkout-a'),
    slicerDevImageRef('same-content', 'checkout-b')
  )
  assert.notEqual(
    slicerDevImageRef('content-a', 'checkout'),
    slicerDevImageRef('content-b', 'checkout')
  )
  assert.equal(slicerDevImageRef(null, 'checkout-a'), 'printstream-slicer-dev:checkout-a')
})

test('the slicer always starts but rebuilds only when its source image differs', () => {
  assert.deepEqual(
    slicerComposeUpArgs('matches'),
    ['--profile', 'slicer', 'up', '-d', 'slicer']
  )
  assert.deepEqual(
    slicerComposeUpArgs('differs'),
    ['--profile', 'slicer', 'up', '-d', '--build', 'slicer']
  )
  assert.deepEqual(
    slicerComposeUpArgs('not-built'),
    ['--profile', 'slicer', 'up', '-d', '--build', 'slicer']
  )
})

function fakeGit({ lastCommit = '2026-08-01T00:00:00Z', dirty = '' } = {}) {
  return (args) => {
    if (args[0] === 'log') return { ok: true, stdout: lastCommit }
    if (args[0] === 'status') return { ok: true, stdout: dirty }
    return { ok: false, stdout: '' }
  }
}

test('an image newer than the last slicer commit matches', () => {
  const result = inspectSlicerSource({ repoRoot: '/repo', run: fakeSourceDocker(), git: fakeGit() })
  assert.equal(result.state, 'matches')
})

test('freshness queries include every build-affecting input but not guidance-only files', () => {
  const calls = []
  const git = (args) => {
    calls.push(args)
    if (args[0] === 'log') return { ok: true, stdout: '2026-08-01T00:00:00Z' }
    if (args[0] === 'status') return { ok: true, stdout: '' }
    return { ok: false, stdout: '' }
  }

  inspectSlicerSource({ repoRoot: '/repo', run: fakeSourceDocker(), git })

  for (const args of calls) {
    assert.ok(args.includes('apps/slicer/Dockerfile'))
    assert.ok(args.includes('.dockerignore'))
    assert.ok(args.includes('package.json'))
    assert.ok(args.includes('package-lock.json'))
    assert.ok(args.includes('tsconfig.base.json'))
    assert.ok(args.includes('apps/slicer/tsconfig.json'))
    assert.ok(args.includes('packages/shared/tsconfig.json'))
    assert.ok(!args.includes('apps/slicer/the development notes'))
    assert.ok(!args.includes('apps/slicer/THIRD-PARTY-NOTICES.txt'))
  }
})

test('a slicer commit newer than the image differs', () => {
  const result = inspectSlicerSource({
    repoRoot: '/repo',
    run: fakeSourceDocker(),
    git: fakeGit({ lastCommit: '2026-09-05T00:00:00Z' })
  })
  assert.equal(result.state, 'differs')
})

test('an uncommitted slicer change newer than the image differs and is named', () => {
  const result = inspectSlicerSource({
    repoRoot: '/repo',
    run: fakeSourceDocker(),
    git: fakeGit({ dirty: ' M apps/slicer/src/index.ts' }),
    stat: () => ({ mtimeMs: Date.parse('2026-09-02T00:00:00Z') })
  })
  assert.equal(result.state, 'differs')
  // The porcelain status column is stripped whether or not the runner trimmed its leading space.
  assert.match(result.reason, /apps\/slicer\/src\/index\.ts/)
  assert.doesNotMatch(result.reason, /^uncommitted M/)
})

// The regression this pins: dirty source used to force a rebuild FOREVER. Building cannot clean a
// working tree, so the next start saw the same `git status` and rebuilt the same image again.
test('an image built after an uncommitted change matches', () => {
  const result = inspectSlicerSource({
    repoRoot: '/repo',
    run: fakeSourceDocker(),
    git: fakeGit({ dirty: ' M apps/slicer/src/index.ts' }),
    stat: () => ({ mtimeMs: Date.parse('2026-08-31T00:00:00Z') })
  })
  assert.equal(result.state, 'matches')
})

test('no container is not-running rather than a staleness claim', () => {
  const result = inspectSlicerSource({ repoRoot: '/repo', run: fakeSourceDocker({ containerId: '' }), git: fakeGit() })
  assert.equal(result.state, 'not-running')
})

test('a stopped checkout reuses its existing current image', () => {
  const result = inspectSlicerSource({
    repoRoot: '/repo',
    run: fakeSourceDocker({ containerId: '' }),
    git: fakeGit(),
    imageRef: 'printstream-slicer-dev'
  })

  assert.equal(result.state, 'matches')
})

test('a stopped checkout with no local image reports that a first build is needed', () => {
  const result = inspectSlicerSource({
    repoRoot: '/repo',
    run: fakeSourceDocker({ containerId: '', created: null }),
    git: fakeGit(),
    imageRef: 'printstream-slicer-dev'
  })

  assert.equal(result.state, 'not-built')
})

test('an image with no readable build time is unknown, never matches', () => {
  const result = inspectSlicerSource({ repoRoot: '/repo', run: fakeSourceDocker({ created: null }), git: fakeGit() })
  assert.equal(result.state, 'unknown')
})
