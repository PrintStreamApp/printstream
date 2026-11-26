/**
 * The SEC-6 production guards: what stops the server at start, what only warns, and what is
 * left alone so existing self-hosted installs keep starting after an upgrade.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkProductionEnvironment, type ProductionGuardInput } from './env-production-guards.js'

/** A production environment that passes every guard; each test changes one thing. */
function productionInput(overrides: Partial<ProductionGuardInput> = {}): ProductionGuardInput {
  return {
    nodeEnv: 'production',
    rawDatabaseUrl: 'postgresql://postgres:6f1c0e9a2b7d@db:5432/printstream?schema=public',
    devAuthUserId: undefined,
    devAuthAccessKey: undefined,
    ...overrides
  }
}

test('a correctly configured production environment has no errors or warnings', () => {
  assert.deepEqual(checkProductionEnvironment(productionInput()), { errors: [], warnings: [] })
})

test('production refuses to start when DATABASE_URL is unset or blank', () => {
  for (const rawDatabaseUrl of [undefined, '', '   ']) {
    const result = checkProductionEnvironment(productionInput({ rawDatabaseUrl }))
    assert.equal(result.errors.length, 1, `${JSON.stringify(rawDatabaseUrl)} must be refused`)
    assert.match(result.errors.join('\n'), /DATABASE_URL must be set in production/)
  }
})

test('production refuses to start with the development sign-in credential set', () => {
  for (const credential of [{ devAuthUserId: 'user-1' }, { devAuthAccessKey: 'k'.repeat(40) }]) {
    const result = checkProductionEnvironment(productionInput(credential))
    assert.equal(result.errors.length, 1)
    assert.match(result.errors.join('\n'), /DEV_AUTH_USER_ID and DEV_AUTH_ACCESS_KEY are for development only/)
  }
})

test('the old default password on the compose database warns but does not refuse', () => {
  // Exactly what every compose file up to v1.3.22 set: refusing it would stop those installs.
  const result = checkProductionEnvironment(productionInput({
    rawDatabaseUrl: 'postgresql://postgres:postgres@db:5432/printstream?schema=public'
  }))
  assert.deepEqual(result.errors, [])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings.join('\n'), /Rotating the database password/)
})

test('the old default password on this machine does not warn', () => {
  // The native server's embedded cluster: a loopback port or a Unix socket, reachable only locally.
  for (const rawDatabaseUrl of [
    'postgresql://postgres:postgres@127.0.0.1:5433/printstream',
    'postgresql://postgres:postgres@localhost/printstream?host=%2Fvar%2Flib%2Fprintstream%2Fdb',
    'postgresql://postgres:postgres@[::1]:5433/printstream'
  ]) {
    assert.deepEqual(checkProductionEnvironment(productionInput({ rawDatabaseUrl })), { errors: [], warnings: [] }, rawDatabaseUrl)
  }
})

test('a different password, or an unparseable URL, does not warn', () => {
  for (const rawDatabaseUrl of [
    'postgresql://postgres:postgres2@db:5432/printstream',
    'not a url'
  ]) {
    assert.deepEqual(checkProductionEnvironment(productionInput({ rawDatabaseUrl })).warnings, [], rawDatabaseUrl)
  }
})

test('nothing is checked outside production', () => {
  for (const nodeEnv of ['development', 'test']) {
    const result = checkProductionEnvironment(productionInput({
      nodeEnv,
      rawDatabaseUrl: undefined,
      devAuthUserId: 'user-1'
    }))
    assert.deepEqual(result, { errors: [], warnings: [] }, nodeEnv)
  }
})
