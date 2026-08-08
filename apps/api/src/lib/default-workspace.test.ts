/**
 * Regression tests for the first-run default workspace bootstrap: it must
 * only create a workspace when none exists and the feature is enabled, and
 * it must seed the built-in auth groups for the new workspace.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

// Deployment mode is fixed when env.ts parses and static imports hoist above
// assignments, so the flag is cleared first and the subject imported
// dynamically. Unset means "cloud" here (the dev tree carries the private
// modules), which is the mode whose derived default these tests pin.
delete process.env.SELF_HOSTED
delete process.env.AUTO_CREATE_DEFAULT_WORKSPACE

const { ensureDefaultWorkspace } = await import('./default-workspace.js')
const { isSelfHostedDeployment } = await import('./deployment-mode.js')

function fakeClient(initialCount: number) {
  const created: Array<{ slug: string; name: string }> = []
  return {
    created,
    client: {
      workspace: {
        count: async () => initialCount,
        create: async (args: { data: { slug: string; name: string } }) => {
          created.push(args.data)
          return { id: 'workspace-1', slug: args.data.slug }
        }
      }
    }
  }
}

test('creates a default workspace and seeds auth groups when no workspace exists', async () => {
  const { client, created } = fakeClient(0)
  const seededWorkspaceIds: string[] = []
  const slug = await ensureDefaultWorkspace({
    enabled: true,
    client,
    ensureGroups: async (_client, workspaceId) => {
      seededWorkspaceIds.push(workspaceId)
    }
  })
  assert.equal(slug, created[0]?.slug)
  assert.equal(created.length, 1)
  assert.deepEqual(seededWorkspaceIds, ['workspace-1'])
})

test('does nothing when a workspace already exists', async () => {
  const { client, created } = fakeClient(2)
  const slug = await ensureDefaultWorkspace({
    enabled: true,
    client,
    ensureGroups: async () => assert.fail('should not seed groups')
  })
  assert.equal(slug, null)
  assert.equal(created.length, 0)
})

test('does nothing when disabled', async () => {
  const { client, created } = fakeClient(0)
  const slug = await ensureDefaultWorkspace({
    enabled: false,
    client,
    ensureGroups: async () => assert.fail('should not seed groups')
  })
  assert.equal(slug, null)
  assert.equal(created.length, 0)
})

test('unset derives from the deployment: the cloud never auto-creates', async () => {
  // The control first: under SELF_HOSTED=true this case would prove nothing.
  assert.equal(isSelfHostedDeployment(), false)
  // The bug this pins: with a static `true` default, a hosted deployment's
  // EMPTY database — its legitimate first-run state — minted a stray
  // "My Workspace" at boot (observed live the day staging was reset).
  const { client, created } = fakeClient(0)
  const slug = await ensureDefaultWorkspace({
    client,
    ensureGroups: async () => assert.fail('should not seed groups')
  })
  assert.equal(slug, null)
  assert.equal(created.length, 0)
})
