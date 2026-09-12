import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  engineProcessEnvironment,
  engineProcessIdentity,
  prepareEngineWritableDirectory
} from './engine-process-security.js'
import { env } from './env.js'

test('root services isolate jobs and retain the configured diagnostic runner', { skip: process.platform === 'win32' }, (context) => {
  context.mock.method(process as NodeJS.Process & { getuid(): number }, 'getuid', () => 0)

  const first = engineProcessIdentity('job-a')
  const same = engineProcessIdentity('job-a')
  const other = engineProcessIdentity('job-b')
  assert.deepEqual(first, same)
  assert.notEqual(first.uid, other.uid)
  assert.notEqual(first.gid, other.gid)
  assert.ok(first.uid != null && first.uid <= 65_534)
  assert.ok(first.gid != null && first.gid <= 65_534)
  assert.deepEqual(engineProcessIdentity(), {
    uid: env.SLICER_ENGINE_UID,
    gid: env.SLICER_ENGINE_GID
  })
})

test('unprivileged development keeps the current process identity', { skip: process.platform === 'win32' }, (context) => {
  context.mock.method(process as NodeJS.Process & { getuid(): number }, 'getuid', () => 1_000)

  assert.deepEqual(engineProcessIdentity(), {})
})

test('native engines inherit runtime settings but no service or deployment secrets', () => {
  assert.deepEqual(engineProcessEnvironment({
    PATH: '/usr/bin',
    LC_MESSAGES: 'C',
    SLICER_SERVICE_TOKEN: 'slicer-secret',
    DATABASE_URL: 'postgres://secret',
    AWS_ACCESS_KEY_ID: 'cloud-secret'
  }, {
    HOME: '/work/job/home'
  }), {
    PATH: '/usr/bin',
    LC_MESSAGES: 'C',
    HOME: '/work/job/home'
  })
})

test('job directories are writable only by the service and the job-specific native group', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'slicer-engine-security-'))
  const directory = path.join(root, 'job')

  try {
    await prepareEngineWritableDirectory(directory, 'job-a')

    const metadata = await stat(directory)
    assert.equal(metadata.mode & 0o777, 0o770)
    if (process.getuid?.() === 0) assert.equal(metadata.gid, engineProcessIdentity('job-a').gid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
