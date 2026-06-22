/* eslint-disable react-refresh/only-export-components -- shared helpers module: exports pure functions, constants, and types, not refreshable components. */
/**
 * Pure helpers, constants, and small shared types for the auth-access settings
 * surfaces. These have no rendering side effects beyond `readAuthAlertDecorator`
 * (which returns a Joy icon element) and are shared across `AuthAccessSection`,
 * its dialogs, and the permission-matrix machinery. Keep logic here free of
 * component state so it stays trivially testable.
 */
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  type AuthGroup,
  type AuthSessionDuration,
  type AuthUser,
  type Permission
} from '@printstream/shared'
import { type DirectoryViewMode } from './DirectoryControls'

export const CUSTOM_SESSION_DURATION_OPTION = 'custom'
export type SessionDurationSelectValue = AuthSessionDuration | typeof CUSTOM_SESSION_DURATION_OPTION

export const SESSION_DURATION_OPTIONS: Array<{
  value: AuthSessionDuration
  label: string
  detail: string
}> = [
  { value: 'day', label: '1 day', detail: 'Recommended idle window for everyday browser sign-ins.' },
  { value: 'week', label: '1 week', detail: 'Longer idle window for trusted personal devices.' },
  { value: 'month', label: '1 month', detail: 'Maximum browser convenience with the longest idle window.' }
]
export const USER_PAGE_SIZE_OPTIONS = [10, 25, 50] as const
export const USER_DIRECTORY_VIEW_MODE_KEY = 'bambu.auth.users.viewMode'

export type RevealedServiceAccountToken = {
  name: string
  tokenPrefix: string
  token: string
}

export function parseUserDirectoryViewMode(raw: string): DirectoryViewMode | null {
  return raw === 'list' || raw === 'icon' ? raw : null
}

export function parseCustomSessionDurationMinutes(value: AuthSessionDuration | null | undefined): number | null {
  if (!value?.startsWith('custom:')) return null

  const minutes = Number.parseInt(value.slice('custom:'.length), 10)
  return Number.isInteger(minutes) ? minutes : null
}

export function formatSessionDurationLabel(value: AuthSessionDuration): string {
  const preset = SESSION_DURATION_OPTIONS.find((option) => option.value === value)
  if (preset) return preset.label

  const minutes = parseCustomSessionDurationMinutes(value)
  if (minutes == null) return 'Custom'
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)} day${minutes === 60 * 24 ? '' : 's'}`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `${minutes} minutes`
}

export function formatSessionDurationDetail(value: AuthSessionDuration): string {
  const preset = SESSION_DURATION_OPTIONS.find((option) => option.value === value)
  if (preset) return preset.detail

  return `Custom idle timeout after ${formatSessionDurationLabel(value).toLowerCase()}.`
}

export function formatSessionDurationSelectLabel(value: SessionDurationSelectValue | null): string | null {
  if (value == null) return null
  if (value === CUSTOM_SESSION_DURATION_OPTION) return 'Custom'
  return formatSessionDurationLabel(value)
}

export function readAuthAlertDecorator(color: 'danger' | 'warning' | 'success' | 'primary' | 'neutral') {
  switch (color) {
    case 'danger':
      return <ErrorOutlineRoundedIcon />
    case 'warning':
      return <WarningAmberRoundedIcon />
    case 'success':
      return <CheckCircleOutlineRoundedIcon />
    case 'primary':
    case 'neutral':
    default:
      return <InfoOutlinedIcon />
  }
}

export function shouldAutoOpenCreatedUserEditor(users: AuthUser[], createdUserId: string): boolean {
  const createdUser = users.find((user) => user.id === createdUserId)
  return createdUser?.canManage !== false
}

export function summarizeRoleFlags(group: AuthGroup): string {
  const flags = []
  if (group.isSystem) flags.push('Built-in')
  if (!group.isEditable) flags.push('Read-only')
  if (!group.isRemovable) flags.push('Protected')
  return flags.length > 0 ? flags.join(' · ') : 'Custom role'
}

export function toggleCollapsedSection(current: ReadonlySet<string>, title: string): Set<string> {
  const next = new Set(current)
  if (next.has(title)) {
    next.delete(title)
  } else {
    next.add(title)
  }
  return next
}

export function orderGroupsForDisplay(groups: AuthGroup[]): AuthGroup[] {
  const builtInOrder = new Map<string, number>([
    ['admin', 0],
    ['platform_manager', 1],
    ['platform_support', 2],
    ['technician', 4],
    ['operator', 5],
    ['viewer', 6]
  ])

  return [
    ...groups
      .filter((group) => group.isSystem)
      .sort((left, right) => {
        const leftRank = builtInOrder.get(left.key ?? '') ?? Number.MAX_SAFE_INTEGER
        const rightRank = builtInOrder.get(right.key ?? '') ?? Number.MAX_SAFE_INTEGER
        if (leftRank !== rightRank) return leftRank - rightRank
        return left.name.localeCompare(right.name)
      }),
    ...groups.filter((group) => !group.isSystem)
  ]
}

export function samePermissions(left: Permission[], right: Permission[]): boolean {
  if (left.length !== right.length) return false
  return left.every((permission, index) => permission === right[index])
}

export function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}
