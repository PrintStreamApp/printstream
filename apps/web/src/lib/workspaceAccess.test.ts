import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countAccessibleWorkspaceChoices, countSwitchableWorkspaceChoices, listAccessibleWorkspaces } from './workspaceAccess'

test('listAccessibleWorkspaces removes duplicate workspace entries and sorts them by name', () => {
  assert.deepEqual(
    listAccessibleWorkspaces([
      { id: 'workspace-2', slug: 'beta', name: 'Beta' },
      { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
      { id: 'workspace-1', slug: 'alpha', name: 'Alpha' }
    ]),
    [
      { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
      { id: 'workspace-2', slug: 'beta', name: 'Beta' }
    ]
  )
})

test('countAccessibleWorkspaceChoices includes platform access as a separate choice', () => {
  assert.equal(countAccessibleWorkspaceChoices({
    workspaces: [
      { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
      { id: 'workspace-2', slug: 'beta', name: 'Beta' },
      { id: 'workspace-1', slug: 'alpha', name: 'Alpha' }
    ],
    includePlatform: true
  }), 3)
})

test('countSwitchableWorkspaceChoices includes returning to platform from a support-access workspace', () => {
  assert.equal(countSwitchableWorkspaceChoices({
    workspaces: [],
    includePlatform: true,
    activeWorkspaceId: 'workspace-support-only'
  }), 1)
})

test('countSwitchableWorkspaceChoices excludes the current workspace from personal workspace options', () => {
  assert.equal(countSwitchableWorkspaceChoices({
    workspaces: [
      { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
      { id: 'workspace-2', slug: 'beta', name: 'Beta' }
    ],
    includePlatform: true,
    activeWorkspaceId: 'workspace-1'
  }), 2)
})
test('countSwitchableWorkspaceChoices counts a billing account for a user with no workspace', () => {
  // Registering for a self-hosted licence creates an account and no workspace.
  // Counting workspaces alone made the chooser unreachable for that user, so
  // their one scope had no route to it and the page rendered empty.
  assert.equal(countSwitchableWorkspaceChoices({
    workspaces: [],
    includePlatform: false,
    activeWorkspaceId: null,
    customerCount: 1
  }), 1)
})

test('countSwitchableWorkspaceChoices ignores accounts the chooser cannot render', () => {
  // The control: a public build registers no billing view, so App passes 0 and
  // nothing changes for a user with nowhere to go.
  assert.equal(countSwitchableWorkspaceChoices({
    workspaces: [],
    includePlatform: false,
    activeWorkspaceId: null,
    customerCount: 0
  }), 0)
})
