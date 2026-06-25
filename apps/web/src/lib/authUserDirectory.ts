import type { AuthUser } from '@printstream/shared'
import type { DirectorySortDirection } from '../components/DirectoryControls'

/**
 * Helpers for deriving the visible user directory from the fetched auth users.
 */
export type UserSortKey = 'name' | 'createdAt' | 'roles' | 'passkeys'
export type UserSortDirection = DirectorySortDirection
export type UserStatusFilter = 'all' | 'enabled' | 'disabled'
export type UserRoleOption = {
  value: string
  label: string
}

/** Sentinel role-filter value matching users with no role assigned (alongside real group ids). */
export const UNASSIGNED_USER_ROLE_FILTER = '__unassigned__'
export const USER_SORT_OPTIONS: Array<{ value: UserSortKey; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'createdAt', label: 'Added' },
  { value: 'roles', label: 'Roles' },
  { value: 'passkeys', label: 'Passkeys' }
]
export const USER_STATUS_OPTIONS: Array<{ value: UserStatusFilter; label: string }> = [
  { value: 'all', label: 'All users' },
  { value: 'enabled', label: 'Enabled users' },
  { value: 'disabled', label: 'Disabled users' }
]

export function buildUserRoleOptions(users: AuthUser[]): UserRoleOption[] {
  const groupsById = new Map<string, AuthUser['groups'][number]>()

  for (const user of users) {
    for (const group of user.groups) {
      if (!groupsById.has(group.id)) {
        groupsById.set(group.id, group)
      }
    }
  }

  return [...groupsById.values()]
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
    .map((group) => ({ value: group.id, label: group.name }))
}

export function filterAndSortUsers(
  users: AuthUser[],
  options: {
    search: string
    statusFilter: UserStatusFilter
    roleFilters: string[]
    sortKey: UserSortKey
    sortDirection: UserSortDirection
  }
): AuthUser[] {
  const normalizedSearch = options.search.trim().toLowerCase()

  return [...users]
    .filter((user) => matchesUserSearch(user, normalizedSearch))
    .filter((user) => matchesUserStatusFilter(user, options.statusFilter))
    .filter((user) => matchesUserRoleFilter(user, options.roleFilters))
    .sort((left, right) => compareUsers(left, right, options.sortKey, options.sortDirection))
}

export function getUserDisplayLabel(user: AuthUser): string {
  return user.displayName?.trim() || user.email
}

function matchesUserSearch(user: AuthUser, normalizedSearch: string): boolean {
  if (normalizedSearch.length === 0) {
    return true
  }

  const haystack = [
    getUserDisplayLabel(user),
    user.email,
    ...user.groups.flatMap((group) => [group.name, group.key]).filter((value): value is string => typeof value === 'string' && value.length > 0)
  ]

  return haystack.some((value) => value.toLowerCase().includes(normalizedSearch))
}

function matchesUserStatusFilter(user: AuthUser, filter: UserStatusFilter): boolean {
  switch (filter) {
    case 'enabled':
      return !user.loginDisabled
    case 'disabled':
      return user.loginDisabled
    default:
      return true
  }
}

/**
 * Multi-select role filter: an empty selection means "all". Otherwise a user
 * matches if it satisfies ANY selected value — the `UNASSIGNED` sentinel matches
 * users with no role, and a group id matches users in that group.
 */
function matchesUserRoleFilter(user: AuthUser, filters: string[]): boolean {
  if (filters.length === 0) {
    return true
  }

  return filters.some((filter) => filter === UNASSIGNED_USER_ROLE_FILTER
    ? user.groups.length === 0
    : user.groups.some((group) => group.id === filter))
}

function compareUsers(left: AuthUser, right: AuthUser, sortKey: UserSortKey, sortDirection: UserSortDirection): number {
  switch (sortKey) {
    case 'createdAt':
      return compareValues(Date.parse(left.createdAt), Date.parse(right.createdAt), sortDirection)
        || compareStrings(getUserDisplayLabel(left), getUserDisplayLabel(right))
    case 'roles':
      return compareValues(left.groups.length, right.groups.length, sortDirection)
        || compareStrings(getUserDisplayLabel(left), getUserDisplayLabel(right))
    case 'passkeys':
      return compareValues(left.passkeyCount, right.passkeyCount, sortDirection)
        || compareStrings(getUserDisplayLabel(left), getUserDisplayLabel(right))
    default:
      return compareStrings(getUserDisplayLabel(left), getUserDisplayLabel(right), sortDirection)
        || compareStrings(left.email, right.email, sortDirection)
  }
}

function compareStrings(left: string, right: string, direction: UserSortDirection = 'asc'): number {
  const comparison = left.localeCompare(right, undefined, { sensitivity: 'base' })
  return direction === 'asc' ? comparison : -comparison
}

function compareValues(left: number, right: number, direction: UserSortDirection): number {
  return direction === 'asc' ? left - right : right - left
}