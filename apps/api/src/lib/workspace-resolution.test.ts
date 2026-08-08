import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listWorkspaces, resolveSoleWorkspace, resolveWideOpenDefaultWorkspace } from './workspace-resolution.js'

test('listWorkspaces requests the shared workspace directory ordering and fields', async () => {
  let findManyArgs: unknown = null

  const workspaces = await listWorkspaces({
    workspace: {
      findMany: async (args: unknown) => {
        findManyArgs = args
        return [{
          id: 'workspace-2',
          slug: 'alpha',
          name: 'Alpha',
          description: 'Workspace'
        }]
      }
    }
  } as never)

  assert.deepEqual(findManyArgs, {
    // The soft-delete scope is asserted, not tolerated: this is the query behind
    // the workspace chooser and auth bootstrap, so a deleted workspace leaking
    // back into it is the failure the whole predicate exists to prevent.
    where: { deletedAt: null },
    orderBy: [
      { name: 'asc' },
      { createdAt: 'asc' }
    ],
    select: {
      id: true,
      slug: true,
      name: true,
      description: true
    }
  })
  assert.deepEqual(workspaces, [{
    id: 'workspace-2',
    slug: 'alpha',
    name: 'Alpha',
    description: 'Workspace'
  }])
})

test('listWorkspaces preserves null descriptions from the workspace directory query', async () => {
  const workspaces = await listWorkspaces({
    workspace: {
      findMany: async () => ([{
        id: 'workspace-3',
        slug: 'beta',
        name: 'Beta',
        description: null
      }])
    }
  } as never)

  assert.deepEqual(workspaces, [{
    id: 'workspace-3',
    slug: 'beta',
    name: 'Beta',
    description: null
  }])
})

const workspace = { id: 'workspace-1', slug: 'workspace', name: 'My Workspace' }
const otherWorkspace = { id: 'workspace-2', slug: 'second', name: 'Second Workspace' }
const demoWorkspace = { id: 'workspace-demo', slug: 'demo', name: 'Demo' }

function soleWorkspaceDeps(overrides: Parameters<typeof resolveSoleWorkspace>[0] = {}) {
  return {
    listCandidateWorkspaces: async () => [workspace],
    isWorkspaceDisabled: async () => false,
    isPublicDemoWorkspace: (workspace: { slug: string }) => workspace.slug === 'demo',
    ...overrides
  }
}

test('resolveSoleWorkspace returns the only real workspace regardless of auth providers', async () => {
  assert.deepEqual(await resolveSoleWorkspace(soleWorkspaceDeps()), workspace)
})

test('resolveSoleWorkspace returns null when no workspace exists', async () => {
  assert.equal(await resolveSoleWorkspace(soleWorkspaceDeps({ listCandidateWorkspaces: async () => [] })), null)
})

test('resolveSoleWorkspace returns null when more than one workspace is a candidate', async () => {
  assert.equal(
    await resolveSoleWorkspace(soleWorkspaceDeps({ listCandidateWorkspaces: async () => [workspace, otherWorkspace] })),
    null
  )
})

test('resolveSoleWorkspace ignores the public demo and disabled workspaces', async () => {
  assert.deepEqual(
    await resolveSoleWorkspace(soleWorkspaceDeps({
      listCandidateWorkspaces: async () => [demoWorkspace, otherWorkspace, workspace],
      isWorkspaceDisabled: async (workspaceId) => workspaceId === otherWorkspace.id
    })),
    workspace
  )
})

function wideOpenDeps(overrides: Parameters<typeof resolveWideOpenDefaultWorkspace>[0] = {}) {
  return {
    listCandidateWorkspaces: async () => [workspace],
    hasAnyEnabledProvider: async () => false,
    isWorkspaceDisabled: async () => false,
    isPublicDemoWorkspace: (workspace: { slug: string }) => workspace.slug === 'demo',
    ...overrides
  }
}

test('resolveWideOpenDefaultWorkspace returns the single wide-open workspace', async () => {
  assert.deepEqual(await resolveWideOpenDefaultWorkspace(wideOpenDeps()), workspace)
})

test('resolveWideOpenDefaultWorkspace returns null when any provider is enabled at platform scope', async () => {
  assert.equal(
    await resolveWideOpenDefaultWorkspace(wideOpenDeps({
      hasAnyEnabledProvider: async (workspace) => workspace == null
    })),
    null
  )
})

test('resolveWideOpenDefaultWorkspace returns null when the workspace itself has auth enabled', async () => {
  assert.equal(
    await resolveWideOpenDefaultWorkspace(wideOpenDeps({
      hasAnyEnabledProvider: async (workspace) => workspace != null
    })),
    null
  )
})

test('resolveWideOpenDefaultWorkspace returns null when more than one workspace is a candidate', async () => {
  assert.equal(
    await resolveWideOpenDefaultWorkspace(wideOpenDeps({
      listCandidateWorkspaces: async () => [workspace, otherWorkspace]
    })),
    null
  )
})

test('resolveWideOpenDefaultWorkspace ignores the public demo and disabled workspaces', async () => {
  assert.deepEqual(
    await resolveWideOpenDefaultWorkspace(wideOpenDeps({
      listCandidateWorkspaces: async () => [demoWorkspace, otherWorkspace, workspace],
      isWorkspaceDisabled: async (workspaceId) => workspaceId === otherWorkspace.id
    })),
    workspace
  )
})

test('resolveWideOpenDefaultWorkspace returns null when no workspaces exist yet', async () => {
  assert.equal(
    await resolveWideOpenDefaultWorkspace(wideOpenDeps({
      listCandidateWorkspaces: async () => []
    })),
    null
  )
})