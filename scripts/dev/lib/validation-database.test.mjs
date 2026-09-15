/** Tests validation database selection without requiring Docker or PostgreSQL. */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  maintenanceDatabaseUrl,
  prepareValidationDatabase,
  REQUIRE_VALIDATION_DATABASE_ENV
} from './validation-database.mjs'

const repoRoot = '/repo'

test('maintenanceDatabaseUrl preserves connection details while selecting postgres', () => {
  assert.equal(
    maintenanceDatabaseUrl('postgresql://user:pass@localhost:5544/worktree?schema=public&sslmode=disable'),
    'postgresql://user:pass@localhost:5544/postgres?schema=public&sslmode=disable'
  )
})

test('an explicit reachable administrator URL wins without invoking Devkit', async () => {
  let preflightCalled = false
  const prepared = await prepareValidationDatabase({
    repoRoot,
    environment: { TEST_ADMIN_DATABASE_URL: 'postgresql://db/postgres' },
    probe: async () => true,
    prepareDevkit: async () => {
      preflightCalled = true
      return null
    }
  })

  assert.equal(preflightCalled, false)
  assert.equal(prepared.source, 'configured test database')
  assert.equal(prepared.environment.DATABASE_URL, undefined)
  assert.equal(prepared.environment.TEST_ADMIN_DATABASE_URL, 'postgresql://db/postgres')
  assert.equal(prepared.environment[REQUIRE_VALIDATION_DATABASE_ENV], '1')
})

test('a reachable DATABASE_URL is adapted without invoking Devkit', async () => {
  let preflightCalled = false
  const prepared = await prepareValidationDatabase({
    repoRoot,
    environment: { DATABASE_URL: 'postgresql://db/worktree' },
    probe: async () => true,
    prepareDevkit: async () => {
      preflightCalled = true
      return null
    }
  })

  assert.equal(preflightCalled, false)
  assert.equal(prepared.source, 'configured database')
  assert.equal(prepared.environment.TEST_ADMIN_DATABASE_URL, 'postgresql://db/postgres')
})

test('Devkit provisions PostgreSQL when the configured database is unavailable', async () => {
  const probes = []
  const prepared = await prepareValidationDatabase({
    repoRoot,
    environment: { DATABASE_URL: 'postgresql://old/worktree' },
    probe: async (url) => {
      probes.push(url)
      return url.includes('devkit')
    },
    prepareDevkit: async (options) => {
      assert.deepEqual(options, { repoRoot })
      return { databaseUrl: 'postgresql://devkit/worktree' }
    }
  })

  assert.deepEqual(probes, [
    'postgresql://old/postgres',
    'postgresql://devkit/postgres'
  ])
  assert.equal(prepared.source, 'Devkit database')
  assert.equal(prepared.environment.DATABASE_URL, 'postgresql://devkit/worktree')
  assert.equal(prepared.environment.TEST_ADMIN_DATABASE_URL, 'postgresql://devkit/postgres')
})

test('full validation fails when neither a database nor Devkit is available', async () => {
  await assert.rejects(
    prepareValidationDatabase({
      repoRoot,
      environment: {},
      probe: async () => false,
      prepareDevkit: async () => null
    }),
    /PostgreSQL is required for full validation; set TEST_ADMIN_DATABASE_URL or enable Devkit/
  )
})

test('an explicit administrator URL fails closed instead of silently falling back', async () => {
  let preflightCalled = false
  await assert.rejects(
    prepareValidationDatabase({
      repoRoot,
      environment: { TEST_ADMIN_DATABASE_URL: 'postgresql://db/postgres' },
      probe: async () => false,
      prepareDevkit: async () => {
        preflightCalled = true
        return { databaseUrl: 'postgresql://devkit/worktree' }
      }
    }),
    /TEST_ADMIN_DATABASE_URL is not reachable/
  )
  assert.equal(preflightCalled, false)
})
