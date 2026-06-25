import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthUser } from '@printstream/shared'
import {
  buildUserRoleOptions,
  filterAndSortUsers,
  getUserDisplayLabel,
  type UserSortDirection,
  type UserSortKey,
  UNASSIGNED_USER_ROLE_FILTER
} from './authUserDirectory'

const users: AuthUser[] = [
  {
    id: 'user-zed',
    email: 'zed@example.com',
    displayName: 'Zed Disabled',
    loginDisabled: true,
    isPlatformUser: false,
    groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
    passkeyCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z'
  },
  {
    id: 'user-alpha',
    email: 'alpha@example.com',
    displayName: 'Alpha Admin',
    loginDisabled: false,
    isPlatformUser: false,
    groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
    passkeyCount: 1,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z'
  },
  {
    id: 'user-mila',
    email: 'mila@example.com',
    displayName: 'Mila Member',
    loginDisabled: false,
    isPlatformUser: false,
    groups: [{ id: 'group-viewer', key: 'viewer', name: 'Viewer' }],
    passkeyCount: 2,
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z'
  },
  {
    id: 'user-nora',
    email: 'nora@example.com',
    displayName: null,
    loginDisabled: false,
    isPlatformUser: false,
    groups: [],
    passkeyCount: 0,
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z'
  }
]

function sortedNames(
  sortKey: UserSortKey,
  sortDirection: UserSortDirection = 'asc',
  extra?: Partial<Parameters<typeof filterAndSortUsers>[1]>
): string[] {
  return filterAndSortUsers(users, {
    search: '',
    statusFilter: 'all',
    roleFilters: [],
    sortKey,
    sortDirection,
    ...extra
  }).map(getUserDisplayLabel)
}

test('buildUserRoleOptions deduplicates and sorts user roles', () => {
  assert.deepEqual(buildUserRoleOptions(users), [
    { value: 'group-admin', label: 'Admin' },
    { value: 'group-viewer', label: 'Viewer' }
  ])
})

test('filterAndSortUsers filters by status and role', () => {
  const disabledAdmins = filterAndSortUsers(users, {
    search: '',
    statusFilter: 'disabled',
    roleFilters: ['group-admin'],
    sortKey: 'name',
    sortDirection: 'asc'
  }).map(getUserDisplayLabel)

  assert.deepEqual(disabledAdmins, ['Zed Disabled'])
})

test('filterAndSortUsers treats multiple selected roles as OR', () => {
  const adminsOrViewers = filterAndSortUsers(users, {
    search: '',
    statusFilter: 'all',
    roleFilters: ['group-admin', 'group-viewer'],
    sortKey: 'name',
    sortDirection: 'asc'
  }).map(getUserDisplayLabel)

  assert.deepEqual(adminsOrViewers, ['Alpha Admin', 'Mila Member', 'Zed Disabled'])
})

test('filterAndSortUsers can filter unassigned users', () => {
  const unassignedUsers = filterAndSortUsers(users, {
    search: '',
    statusFilter: 'all',
    roleFilters: [UNASSIGNED_USER_ROLE_FILTER],
    sortKey: 'name',
    sortDirection: 'asc'
  }).map(getUserDisplayLabel)

  assert.deepEqual(unassignedUsers, ['nora@example.com'])
})

test('filterAndSortUsers searches name, email, and role metadata', () => {
  assert.deepEqual(
    filterAndSortUsers(users, {
      search: 'viewer',
      statusFilter: 'all',
      roleFilters: [],
      sortKey: 'name',
      sortDirection: 'asc'
    }).map(getUserDisplayLabel),
    ['Mila Member']
  )
})

test('filterAndSortUsers sorts by created date descending', () => {
  assert.deepEqual(sortedNames('createdAt', 'desc'), [
    'Mila Member',
    'nora@example.com',
    'Alpha Admin',
    'Zed Disabled'
  ])
})