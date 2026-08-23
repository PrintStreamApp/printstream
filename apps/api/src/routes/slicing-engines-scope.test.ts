process.env.NODE_ENV = 'test'

/**
 * Who may manage slicer engines.
 *
 * The slicer is shared by every workspace on a deployment, but the routes are
 * workspace-scoped, so on the cloud, one workspace's admin removing an engine
 * would break slicing for every other tenant. The gate is a TENANCY rule, not a
 * product one, so it is pinned apart from the permission check: a refactor that
 * keeps the permission but drops this would reintroduce a cross-tenant hazard
 * with nothing failing.
 *
 * `resolveDeploymentKind` is the decision the routes stand on, tested directly
 * because the alternative, booting a router with a faked deployment, asserts
 * the mock more than the rule.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveDeploymentKind } from '../lib/deployment-mode.js'

/** The routes are reachable exactly when this is not the multi-tenant cloud. */
function engineManagementAllowed(input: Parameters<typeof resolveDeploymentKind>[0]): boolean {
  return resolveDeploymentKind(input) !== 'cloud'
}

test('the multi-tenant cloud cannot manage engines from a workspace', () => {
  // The hazard: one tenant removing the engine every other tenant slices with.
  assert.equal(
    engineManagementAllowed({ native: false, selfHosted: false, hasPrivateModules: true }),
    false
  )
})

test('a single-operator deployment can', () => {
  // Docker/OSS and the native app: "the operator" and "everyone affected" are
  // the same person, which is what makes the change theirs to make.
  assert.equal(engineManagementAllowed({ native: true, selfHosted: undefined, hasPrivateModules: false }), true)
  assert.equal(engineManagementAllowed({ native: false, selfHosted: true, hasPrivateModules: true }), true)
  assert.equal(engineManagementAllowed({ native: false, selfHosted: undefined, hasPrivateModules: false }), true)
})

test('a native build is never treated as cloud, whatever else is set', () => {
  // Native wins outright: a packaged app that shipped with the private modules
  // present must not inherit the cloud's restriction.
  assert.equal(engineManagementAllowed({ native: true, selfHosted: false, hasPrivateModules: true }), true)
})
