/**
 * The three deployments, and the implication that used to be an `||`.
 *
 * `PRINTSTREAM_NATIVE` semantically implies self-hosted, and that was encoded at
 * exactly ONE of sixteen `isSelfHostedDeployment()` call sites — inside
 * `license-enforcement.ts`. Every other consumer (auth-provider selection,
 * default-workspace bootstrap, workspace context, print dispatch, bridge
 * updates, admin plugins, email delivery) got the unpatched answer, and was safe
 * only because the native bundle happens to ship no `src/private` directory —
 * i.e. the `||` was load-bearing solely under a configuration that would already
 * be broken. These pin the implication in the model, so a native build can no
 * longer be told it is cloud.
 *
 * Asserted against the pure resolver rather than the env-reading wrapper, since
 * `env` is parsed once per process and one test file cannot hold three
 * environments.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveDeploymentKind } from './deployment-mode.js'

test('the native app is native, and therefore self-hosted', () => {
  assert.equal(
    resolveDeploymentKind({ native: true, selfHosted: undefined, hasPrivateModules: true }),
    'native'
  )
})

test('native wins over an explicit SELF_HOSTED, being the more specific answer', () => {
  assert.equal(
    resolveDeploymentKind({ native: true, selfHosted: true, hasPrivateModules: false }),
    'native'
  )
  // And over one that says otherwise: a native build is never the cloud.
  assert.equal(
    resolveDeploymentKind({ native: true, selfHosted: false, hasPrivateModules: true }),
    'native'
  )
})

test('SELF_HOSTED alone is the Docker/OSS deployment', () => {
  assert.equal(
    resolveDeploymentKind({ native: false, selfHosted: true, hasPrivateModules: true }),
    'self-hosted'
  )
})

test('with no flags, the presence of the private modules decides', () => {
  assert.equal(
    resolveDeploymentKind({ native: false, selfHosted: undefined, hasPrivateModules: true }),
    'cloud'
  )
  // The OSS export strips them, which is how a public build knows itself.
  assert.equal(
    resolveDeploymentKind({ native: false, selfHosted: undefined, hasPrivateModules: false }),
    'self-hosted'
  )
})

test('an explicit SELF_HOSTED=false overrides the derivation', () => {
  // Running the private tree from source with the flag off is the cloud.
  assert.equal(
    resolveDeploymentKind({ native: false, selfHosted: false, hasPrivateModules: false }),
    'cloud'
  )
})
