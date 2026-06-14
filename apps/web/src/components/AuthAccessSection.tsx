import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  ModalClose,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  Textarea,
  Tooltip,
  Typography
} from '@mui/joy'
import { Popper } from '@mui/base/Popper'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE,
  AUTH_SESSION_DURATION_MINUTES_MIN,
  type AuthBootstrap,
  type AuthSessionDuration,
  extractErrorMessage,
  type AuthManagementStatus,
  type AuthGroup,
  type AuthGroupListResponse,
  type AuthUserResponse,
  type AuthSessionListResponse,
  type AuthServiceAccount,
  type AuthServiceAccountListResponse,
  type AuthSessionPolicy,
  type AuthUser,
  type AuthUserListResponse,
  type CreateManagedAuthUserRequest,
  type CreateAuthServiceAccountRequest,
  type CreateAuthServiceAccountResponse,
  type CreateAuthGroupRequest,
  type GeneralSettings,
  type Permission,
  type PermissionDefinition,
  type UpdateAuthUserRequest,
  type UpdateAuthServiceAccountRequest,
  type UpdateAuthUserGroupsRequest,
  type UpdateAuthGroupRequest,
  getPermissionPrerequisites,
  resolveImpliedPermissions
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../lib/apiClient'
import {
  ALL_USER_ROLE_FILTER,
  buildUserRoleOptions,
  filterAndSortUsers,
  getUserDisplayLabel,
  type UserSortDirection,
  type UserSortKey,
  type UserStatusFilter,
  USER_SORT_OPTIONS,
  USER_STATUS_OPTIONS,
  UNASSIGNED_USER_ROLE_FILTER
} from '../lib/authUserDirectory'
import { authQueryKeys, invalidateAuthQueries, platformAuthScopeKey } from '../lib/authQuery'
import { deriveAuthHealthSignals } from '../lib/authUi'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'
import { webPluginRegistry } from '../plugin/registry'
import { AuthSessionList } from './AuthSessionList'
import { BackAwareModal as Modal } from './BackAwareModal'
import { type DirectoryViewMode } from './DirectoryControls'
import { DialogSection } from './DialogSection'
import { DirectoryFiltersButton, DirectoryFiltersDialog, DirectoryPrimaryToolbar } from './DirectoryToolbar'
import { useMobileViewport } from './useMobileViewport'
import { SectionNav } from './dashboard/SectionNav'
import { sectionScrollMarginTop } from './dashboard/SectionNav.constants'
import { HorizontalOverflowScroller } from './HorizontalOverflowScroller'
import { ProviderRecentVerificationDialog } from './ProviderRecentVerificationDialog'
import { PaginatedSection } from './PaginationFooter'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'

type AuthAccessSectionProps = {
  status: AuthManagementStatus | undefined
  statusLoading: boolean
  statusError: string | null
  authProviders: AuthBootstrap['providers']
  authScopeKey?: string
  actorEmail?: string
  canManageSupportAccess?: boolean
  mode?: AuthAccessSectionMode
  onOpenUsers?: () => void
  onOpenRoles?: () => void
}

type AuthAccessSectionMode = 'full' | 'overview' | 'users' | 'roles'

type PermissionSection = {
  title: string
  permissions: PermissionDefinition[]
}

type PermissionSectionRows = {
  title: string
  rows: FlattenedPermissionTreeRow[]
}

type EditorState =
  | { mode: 'create' }
  | { mode: 'group'; groupId: string }

type ServiceAccountEditorState =
  | { mode: 'create' }
  | { mode: 'service-account'; serviceAccountId: string }

type RevealedServiceAccountToken = {
  name: string
  tokenPrefix: string
  token: string
}

type PendingSensitiveAction =
  | { type: 'update-support-access'; body: Partial<Pick<GeneralSettings, 'supportAccessEnabled' | 'supportAccessPermissions'>> }
  | { type: 'create-group'; body: CreateAuthGroupRequest }
  | { type: 'update-group'; groupId: string; body: UpdateAuthGroupRequest }
  | { type: 'create-user'; body: CreateManagedAuthUserRequest }
  | { type: 'update-user-groups'; userId: string; body: UpdateAuthUserGroupsRequest }
  | { type: 'create-service-account'; body: CreateAuthServiceAccountRequest }
  | { type: 'update-service-account'; serviceAccountId: string; body: UpdateAuthServiceAccountRequest }

const CUSTOM_SESSION_DURATION_OPTION = 'custom'
type SessionDurationSelectValue = AuthSessionDuration | typeof CUSTOM_SESSION_DURATION_OPTION

const SESSION_DURATION_OPTIONS: Array<{
  value: AuthSessionDuration
  label: string
  detail: string
}> = [
  { value: 'day', label: '1 day', detail: 'Recommended idle window for everyday browser sign-ins.' },
  { value: 'week', label: '1 week', detail: 'Longer idle window for trusted personal devices.' },
  { value: 'month', label: '1 month', detail: 'Maximum browser convenience with the longest idle window.' }
]
const USER_PAGE_SIZE_OPTIONS = [10, 25, 50] as const
const USER_DIRECTORY_VIEW_MODE_KEY = 'bambu.auth.users.viewMode'

function parseUserDirectoryViewMode(raw: string): DirectoryViewMode | null {
  return raw === 'list' || raw === 'icon' ? raw : null
}

function parseCustomSessionDurationMinutes(value: AuthSessionDuration | null | undefined): number | null {
  if (!value?.startsWith('custom:')) return null

  const minutes = Number.parseInt(value.slice('custom:'.length), 10)
  return Number.isInteger(minutes) ? minutes : null
}

function formatSessionDurationLabel(value: AuthSessionDuration): string {
  const preset = SESSION_DURATION_OPTIONS.find((option) => option.value === value)
  if (preset) return preset.label

  const minutes = parseCustomSessionDurationMinutes(value)
  if (minutes == null) return 'Custom'
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)} day${minutes === 60 * 24 ? '' : 's'}`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `${minutes} minutes`
}

function formatSessionDurationDetail(value: AuthSessionDuration): string {
  const preset = SESSION_DURATION_OPTIONS.find((option) => option.value === value)
  if (preset) return preset.detail

  return `Custom idle timeout after ${formatSessionDurationLabel(value).toLowerCase()}.`
}

function formatSessionDurationSelectLabel(value: SessionDurationSelectValue | null): string | null {
  if (value == null) return null
  if (value === CUSTOM_SESSION_DURATION_OPTION) return 'Custom'
  return formatSessionDurationLabel(value)
}

/**
 * Settings subsection for auth roles, user/service-account access, and
 * provider-neutral session policy.
 */
export function AuthAccessSection({
  status,
  statusLoading,
  statusError,
  authProviders,
  authScopeKey = platformAuthScopeKey,
  actorEmail = '',
  canManageSupportAccess = false,
  mode = 'full',
  onOpenUsers,
  onOpenRoles
}: AuthAccessSectionProps) {
  const isMobile = useMobileViewport()
  const queryClient = useQueryClient()
  const hasEnabledAuthProvider = authProviders.some((provider) => provider.enabled)
  const hasTenantScopedSettings = authScopeKey !== platformAuthScopeKey
  const capabilities = status?.capabilities
  const canViewUsers = capabilities?.canViewUsers ?? false
  const canCreateUsers = capabilities?.canCreateUsers ?? false
  const canEditUsers = capabilities?.canEditUsers ?? false
  const canDisableUserSignIn = capabilities?.canDisableUserSignIn ?? false
  const canDeleteUsers = capabilities?.canDeleteUsers ?? false
  const canAssignUserRoles = capabilities?.canAssignUserRoles ?? false
  const canViewUserSessions = capabilities?.canViewUserSessions ?? false
  const canRevokeUserSessions = capabilities?.canRevokeUserSessions ?? false
  const canViewUserPasskeys = capabilities?.canViewUserPasskeys ?? false
  const canEditUserPasskeys = capabilities?.canEditUserPasskeys ?? false
  const canRevokeUserPasskeys = capabilities?.canRevokeUserPasskeys ?? false
  const canViewRoles = capabilities?.canViewRoles ?? false
  const canCreateRoles = capabilities?.canCreateRoles ?? false
  const canEditRoles = capabilities?.canEditRoles ?? false
  const canDeleteRoles = capabilities?.canDeleteRoles ?? false
  const canAssignRolePermissions = capabilities?.canAssignRolePermissions ?? false
  const canViewServiceAccounts = capabilities?.canViewServiceAccounts ?? false
  const canCreateServiceAccounts = capabilities?.canCreateServiceAccounts ?? false
  const canEditServiceAccounts = capabilities?.canEditServiceAccounts ?? false
  const canRevokeServiceAccounts = capabilities?.canRevokeServiceAccounts ?? false
  const canAssignServiceAccountRoles = capabilities?.canAssignServiceAccountRoles ?? false
  const canManageSessionPolicy = capabilities?.canManageSessionPolicy ?? false
  const assignablePermissionSet = useMemo(
    () => new Set(status?.assignablePermissions ?? []),
    [status?.assignablePermissions]
  )
  const groupsQueryKey = authQueryKeys.groups(authScopeKey)
  const usersQueryKey = authQueryKeys.users(authScopeKey)
  const serviceAccountsQueryKey = authQueryKeys.serviceAccounts(authScopeKey)
  const managementStatusQueryKey = authQueryKeys.managementStatus(authScopeKey)
  const localStatusQueryKey = authQueryKeys.localStatus(authScopeKey)
  const [editorState, setEditorState] = useState<EditorState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AuthGroup | null>(null)
  const [createUserDialogOpen, setCreateUserDialogOpen] = useState(false)
  const [userEditorUserId, setUserEditorUserId] = useState<string | null>(null)
  const [deleteUserTarget, setDeleteUserTarget] = useState<AuthUser | null>(null)
  const [serviceAccountEditorState, setServiceAccountEditorState] = useState<ServiceAccountEditorState | null>(null)
  const [revealedServiceAccountToken, setRevealedServiceAccountToken] = useState<RevealedServiceAccountToken | null>(null)
  const [pendingSensitiveAction, setPendingSensitiveAction] = useState<PendingSensitiveAction | null>(null)
  const [supportPermissionsDialogOpen, setSupportPermissionsDialogOpen] = useState(false)
  const [userSearch, setUserSearch] = useState('')
  const [userStatusFilter, setUserStatusFilter] = useState<UserStatusFilter>('all')
  const [userRoleFilter, setUserRoleFilter] = useState<string>(ALL_USER_ROLE_FILTER)
  const [userSortKey, setUserSortKey] = useState<UserSortKey>('name')
  const [userSortDirection, setUserSortDirection] = useState<UserSortDirection>('asc')
  const [userPage, setUserPage] = useState(1)
  const [userPageSize, setUserPageSize] = useState<number>(USER_PAGE_SIZE_OPTIONS[1])
  const [userFiltersDialogOpen, setUserFiltersDialogOpen] = useState(false)
  const [userViewMode, setUserViewMode] = useLocalStorageState<DirectoryViewMode>(
    USER_DIRECTORY_VIEW_MODE_KEY,
    'icon',
    parseUserDirectoryViewMode,
    String
  )
  const [customSessionDurationMinutes, setCustomSessionDurationMinutes] = useState<string>(() => {
    const minutes = parseCustomSessionDurationMinutes(status?.sessionDuration)
    return String(minutes ?? AUTH_SESSION_DURATION_MINUTES_MIN)
  })
  const [sessionDurationSelection, setSessionDurationSelection] = useState<SessionDurationSelectValue | null>(() => {
    if (!status?.sessionDuration) return null

    return SESSION_DURATION_OPTIONS.some((option) => option.value === status.sessionDuration)
      ? status.sessionDuration
      : CUSTOM_SESSION_DURATION_OPTION
  })
  const [supportAccessPermissionsDraft, setSupportAccessPermissionsDraft] = useState<Permission[]>([])
  const effectiveUserViewMode: DirectoryViewMode = isMobile ? 'list' : userViewMode

  const groupsQuery = useQuery({
    queryKey: groupsQueryKey,
    queryFn: ({ signal }) => apiFetch<AuthGroupListResponse>('/api/auth/groups', { signal }),
    enabled: canViewRoles
  })
  const usersQuery = useQuery({
    queryKey: usersQueryKey,
    queryFn: ({ signal }) => apiFetch<AuthUserListResponse>('/api/auth/users', { signal }),
    enabled: hasEnabledAuthProvider && canViewUsers
  })
  const userSessionsQuery = useQuery({
    queryKey: authQueryKeys.userSessions(authScopeKey, userEditorUserId),
    queryFn: ({ signal }) => apiFetch<AuthSessionListResponse>(`/api/auth/users/${userEditorUserId}/sessions`, { signal }),
    enabled: hasEnabledAuthProvider && canViewUserSessions && Boolean(userEditorUserId)
  })
  const serviceAccountsQuery = useQuery({
    queryKey: serviceAccountsQueryKey,
    queryFn: ({ signal }) => apiFetch<AuthServiceAccountListResponse>('/api/auth/service-accounts', { signal }),
    enabled: hasEnabledAuthProvider && hasTenantScopedSettings && canViewServiceAccounts
  })
  const generalSettingsQuery = useQuery({
    queryKey: ['general-settings'],
    queryFn: ({ signal }) => apiFetch<GeneralSettings>('/api/settings', { signal }),
    enabled: hasEnabledAuthProvider && hasTenantScopedSettings && (mode === 'full' || mode === 'overview')
  })

  function isRecentAuthError(error: unknown): boolean {
    return extractErrorMessage(error) === AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE
  }

  function openRecentVerification(action: PendingSensitiveAction) {
    setPendingSensitiveAction(action)
  }

  function closeRecentVerification() {
    setPendingSensitiveAction(null)
  }

  const updateSupportAccessMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (body: Partial<Pick<GeneralSettings, 'supportAccessEnabled' | 'supportAccessPermissions'>>) =>
      apiFetch<GeneralSettings>('/api/settings', {
        method: 'PUT',
        body
      }),
    onError: (error, body) => {
      if (isRecentAuthError(error)) {
        openRecentVerification({ type: 'update-support-access', body })
      }
    },
    onSuccess: (data, body) => {
      queryClient.setQueryData(['general-settings'], data)
      if (body.supportAccessPermissions !== undefined) {
        setSupportPermissionsDialogOpen(false)
      }
    }
  })

  const createGroupMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (body: CreateAuthGroupRequest) =>
      apiFetch<{ group: AuthGroup }>('/api/auth/groups', {
        method: 'POST',
        body
      }),
    onError: (error, body) => {
      if (isRecentAuthError(error)) {
        openRecentVerification({ type: 'create-group', body })
      }
    },
    onSuccess: async () => {
      setEditorState(null)
      await invalidateAuthQueries(queryClient, groupsQueryKey, managementStatusQueryKey, localStatusQueryKey, usersQueryKey, serviceAccountsQueryKey)
    }
  })

  const updateGroupMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: ({ groupId, body }: { groupId: string; body: UpdateAuthGroupRequest }) =>
      apiFetch<{ group: AuthGroup }>(`/api/auth/groups/${groupId}`, {
        method: 'PATCH',
        body
      }),
    onError: (error, variables) => {
      if (isRecentAuthError(error)) {
        openRecentVerification({ type: 'update-group', groupId: variables.groupId, body: variables.body })
      }
    },
    onSuccess: async () => {
      setEditorState(null)
      await invalidateAuthQueries(queryClient, groupsQueryKey, usersQueryKey, serviceAccountsQueryKey)
    }
  })

  const deleteGroupMutation = useMutation({
    mutationFn: (groupId: string) =>
      apiFetch<void>(`/api/auth/groups/${groupId}`, {
        method: 'DELETE'
      }),
    onSuccess: async () => {
      setDeleteTarget(null)
      await invalidateAuthQueries(queryClient, groupsQueryKey, managementStatusQueryKey, localStatusQueryKey, usersQueryKey, serviceAccountsQueryKey)
    }
  })
  const createUserMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: async (body: CreateManagedAuthUserRequest) => {
      return await apiFetch<AuthUserResponse>('/api/auth/users', {
        method: 'POST',
        body
      })
    },
    onError: (error, body) => {
      if (isRecentAuthError(error)) {
        openRecentVerification({ type: 'create-user', body })
      }
    },
    onSuccess: async (data) => {
      setCreateUserDialogOpen(false)
      await invalidateAuthQueries(queryClient, usersQueryKey, groupsQueryKey, managementStatusQueryKey, localStatusQueryKey)

      const refreshedUsers = queryClient.getQueryData<AuthUserListResponse>(usersQueryKey)?.users ?? []
      if (shouldAutoOpenCreatedUserEditor(refreshedUsers, data.user.id)) {
        setUserEditorUserId(data.user.id)
      }
    }
  })
  const updateUserMutation = useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateAuthUserRequest }) =>
      apiFetch<{ user: AuthUser }>(`/api/auth/users/${userId}`, {
        method: 'PATCH',
        body
      }),
    onSuccess: async () => {
      await invalidateAuthQueries(queryClient, usersQueryKey, managementStatusQueryKey, localStatusQueryKey)
    }
  })
  const updateUserGroupsMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: ({ userId, body }: { userId: string; body: UpdateAuthUserGroupsRequest }) =>
      apiFetch<{ user: AuthUser }>(`/api/auth/users/${userId}/groups`, {
        method: 'PATCH',
        body
      }),
    onError: (error, variables) => {
      if (isRecentAuthError(error)) {
        openRecentVerification({ type: 'update-user-groups', userId: variables.userId, body: variables.body })
      }
    },
    onSuccess: async () => {
      setUserEditorUserId(null)
      await queryClient.invalidateQueries({ queryKey: usersQueryKey })
    }
  })
  const revokeUserSessionMutation = useMutation({
    mutationFn: ({ userId, sessionId }: { userId: string; sessionId: string }) =>
      apiFetch<void>(`/api/auth/users/${userId}/sessions/${sessionId}/revoke`, {
        method: 'POST'
      }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: authQueryKeys.userSessions(authScopeKey, variables.userId) })
    }
  })
  const deleteUserMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/api/auth/users/${userId}`, {
        method: 'DELETE'
      }),
    onSuccess: async () => {
      setDeleteUserTarget(null)
      setUserEditorUserId(null)
      await invalidateAuthQueries(queryClient, usersQueryKey, managementStatusQueryKey, localStatusQueryKey)
    }
  })
  const createServiceAccountMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (body: CreateAuthServiceAccountRequest) =>
      apiFetch<CreateAuthServiceAccountResponse>('/api/auth/service-accounts', {
        method: 'POST',
        body
      }),
    onError: (error, body) => {
      if (isRecentAuthError(error)) {
        openRecentVerification({ type: 'create-service-account', body })
      }
    },
    onSuccess: async (data) => {
      setServiceAccountEditorState(null)
      setRevealedServiceAccountToken({
        name: data.serviceAccount.name,
        tokenPrefix: data.serviceAccount.tokenPrefix,
        token: data.token
      })
      await invalidateAuthQueries(queryClient, serviceAccountsQueryKey, managementStatusQueryKey, localStatusQueryKey)
    }
  })
  const updateServiceAccountMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: ({ serviceAccountId, body }: { serviceAccountId: string; body: UpdateAuthServiceAccountRequest }) =>
      apiFetch<{ serviceAccount: AuthServiceAccount }>(`/api/auth/service-accounts/${serviceAccountId}`, {
        method: 'PATCH',
        body
      }),
    onError: (error, variables) => {
      if (isRecentAuthError(error)) {
        openRecentVerification({
          type: 'update-service-account',
          serviceAccountId: variables.serviceAccountId,
          body: variables.body
        })
      }
    },
    onSuccess: async () => {
      setServiceAccountEditorState(null)
      await queryClient.invalidateQueries({ queryKey: serviceAccountsQueryKey })
    }
  })
  const revokeServiceAccountMutation = useMutation({
    mutationFn: (serviceAccountId: string) =>
      apiFetch<{ serviceAccount: AuthServiceAccount }>(`/api/auth/service-accounts/${serviceAccountId}/revoke`, {
        method: 'POST'
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: serviceAccountsQueryKey })
    }
  })
  const updateSessionPolicyMutation = useMutation({
    mutationFn: (sessionDuration: AuthSessionDuration) =>
      apiFetch<AuthSessionPolicy>('/api/auth/session-policy', {
        method: 'PUT',
        body: { sessionDuration }
      }),
    onSuccess: async () => {
      await invalidateAuthQueries(queryClient, managementStatusQueryKey, localStatusQueryKey)
    }
  })

  async function executePendingSensitiveAction(action: PendingSensitiveAction) {
    switch (action.type) {
      case 'update-support-access':
        await updateSupportAccessMutation.mutateAsync(action.body)
        return
      case 'create-group':
        await createGroupMutation.mutateAsync(action.body)
        return
      case 'update-group':
        await updateGroupMutation.mutateAsync({ groupId: action.groupId, body: action.body })
        return
      case 'create-user':
        await createUserMutation.mutateAsync(action.body)
        return
      case 'update-user-groups':
        await updateUserGroupsMutation.mutateAsync({ userId: action.userId, body: action.body })
        return
      case 'create-service-account':
        await createServiceAccountMutation.mutateAsync(action.body)
        return
      case 'update-service-account':
        await updateServiceAccountMutation.mutateAsync({
          serviceAccountId: action.serviceAccountId,
          body: action.body
        })
    }
  }

  async function handleRecentVerificationSuccess() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: authQueryKeys.bootstrap }),
      queryClient.invalidateQueries({ queryKey: ['general-settings'] })
    ])

    const action = pendingSensitiveAction
    setPendingSensitiveAction(null)

    if (!action) {
      return
    }

    try {
      await executePendingSensitiveAction(action)
    } catch (error) {
      if (isRecentAuthError(error)) {
        setPendingSensitiveAction(action)
        return
      }
      throw error
    }
  }

  const permissionDefinitions = useMemo(
    () => status?.permissionDefinitions ?? [],
    [status?.permissionDefinitions]
  )
  const permissionSections = useMemo(
    () => buildPermissionSections(permissionDefinitions),
    [permissionDefinitions]
  )
  const permissionLabelByKey = useMemo(
    () => new Map(permissionDefinitions.map((definition) => [definition.key, definition.label] as const)),
    [permissionDefinitions]
  )
  const groups = useMemo(() => groupsQuery.data?.groups ?? [], [groupsQuery.data?.groups])
  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data?.users])
  const serviceAccounts = useMemo(() => serviceAccountsQuery.data?.serviceAccounts ?? [], [serviceAccountsQuery.data?.serviceAccounts])
  const localAuthEnabled = authProviders.some((provider) => provider.id === 'auth-local' && provider.enabled)
  const normalizedCustomSessionDurationMinutes = customSessionDurationMinutes.trim()
  const parsedCustomSessionDurationMinutes = /^\d+$/.test(normalizedCustomSessionDurationMinutes)
    ? Number.parseInt(normalizedCustomSessionDurationMinutes, 10)
    : Number.NaN
  const customSessionDurationError = normalizedCustomSessionDurationMinutes.length === 0
    ? 'Enter a duration in whole minutes.'
    : !Number.isInteger(parsedCustomSessionDurationMinutes)
      ? 'Enter a duration in whole minutes.'
      : parsedCustomSessionDurationMinutes < AUTH_SESSION_DURATION_MINUTES_MIN
        ? `Custom sessions must be at least ${AUTH_SESSION_DURATION_MINUTES_MIN} minutes.`
        : null
  const customSessionDurationValue = customSessionDurationError == null
    ? (`custom:${parsedCustomSessionDurationMinutes}` as AuthSessionDuration)
    : null
  const effectiveSessionDurationSelection = sessionDurationSelection ?? (
    !status?.sessionDuration
      ? null
      : SESSION_DURATION_OPTIONS.some((option) => option.value === status.sessionDuration)
        ? status.sessionDuration
        : CUSTOM_SESSION_DURATION_OPTION
  )
  const showCustomSessionDurationControls = effectiveSessionDurationSelection === CUSTOM_SESSION_DURATION_OPTION
  const sessionDurationLabel = formatSessionDurationSelectLabel(effectiveSessionDurationSelection)
    ?? (statusLoading ? 'Loading…' : 'Select duration')
  const sessionDurationDetail = !status
    ? 'Loading the current policy…'
    : effectiveSessionDurationSelection == null || effectiveSessionDurationSelection === CUSTOM_SESSION_DURATION_OPTION
      ? formatSessionDurationDetail(status.sessionDuration)
      : formatSessionDurationDetail(effectiveSessionDurationSelection)
  const customSessionDurationOptionDetail = customSessionDurationValue
    ? formatSessionDurationDetail(customSessionDurationValue)
    : `Set a custom idle timeout of at least ${AUTH_SESSION_DURATION_MINUTES_MIN} minutes.`
  const adminGroupKey = 'admin'
  const authHealthSignals = useMemo(
    () => deriveAuthHealthSignals(users, { localAuthEnabled, adminGroupKey }),
    [localAuthEnabled, users, adminGroupKey]
  )
  const editingGroup = editorState?.mode === 'group'
    ? groups.find((group) => group.id === editorState.groupId) ?? null
    : null
  const editingUser = userEditorUserId
    ? users.find((user) => user.id === userEditorUserId) ?? null
    : null
  const editingServiceAccount = serviceAccountEditorState?.mode === 'service-account'
    ? serviceAccounts.find((serviceAccount) => serviceAccount.id === serviceAccountEditorState.serviceAccountId) ?? null
    : null
  const supportAccessEnabled = generalSettingsQuery.data?.supportAccessEnabled ?? true
  const supportAccessPermissions = useMemo(
    () => generalSettingsQuery.data?.supportAccessPermissions ?? permissionDefinitions.map((definition) => definition.key),
    [generalSettingsQuery.data?.supportAccessPermissions, permissionDefinitions]
  )
  const supportAccessPermissionsChanged = !samePermissions(supportAccessPermissionsDraft, supportAccessPermissions)
  const supportAccessError = updateSupportAccessMutation.error
    ? (isRecentAuthError(updateSupportAccessMutation.error) ? null : extractErrorMessage(updateSupportAccessMutation.error))
    : null
  const enabledAdminUserIds = useMemo(
    () => users
      .filter((user) => !user.loginDisabled && user.groups.some((group) => group.key === adminGroupKey))
      .map((user) => user.id),
    [users, adminGroupKey]
  )
  const supportAccessDisableBlockedByMissingAdmin = hasEnabledAuthProvider
    && supportAccessEnabled
    && usersQuery.isSuccess
    && enabledAdminUserIds.length === 0
  const supportAccessDisableWaitingForUsers = hasEnabledAuthProvider
    && supportAccessEnabled
    && usersQuery.isLoading
  const showSupportControls = hasEnabledAuthProvider && (mode === 'full' || mode === 'overview') && hasTenantScopedSettings
  const showSessionSecurity = hasEnabledAuthProvider && (mode === 'full' || mode === 'overview')
  const showSessionDuration = hasEnabledAuthProvider && (mode === 'full' || mode === 'overview')
  const showAuthHealth = hasEnabledAuthProvider && (mode === 'full' || mode === 'overview') && authHealthSignals.length > 0
  const showManagementOverview = mode === 'overview'
  const showUsers = hasEnabledAuthProvider && (mode === 'full' || mode === 'users') && (canViewUsers || canCreateUsers)
  const showRoles = (mode === 'roles' || (hasEnabledAuthProvider && mode === 'full')) && (canViewRoles || canCreateRoles)
  const showServiceAccounts = (mode === 'full' || mode === 'overview') && hasTenantScopedSettings && (canViewServiceAccounts || canCreateServiceAccounts)
  const sections = [
    ...(showSessionSecurity ? [{ id: 'session-security', label: 'Session security' }] : []),
    ...(showSessionDuration ? [{ id: 'session-duration', label: 'Session duration' }] : []),
    ...(showUsers ? [{ id: 'users', label: 'Users' }] : []),
    ...(showRoles ? [{ id: 'roles', label: mode === 'roles' ? 'Role permissions' : 'Access control' }] : []),
    ...(showServiceAccounts ? [{ id: 'service-accounts', label: 'Service accounts' }] : []),
    ...(showSupportControls && hasTenantScopedSettings ? [{ id: 'support-access', label: 'Support access' }] : [])
  ]
  const showSectionNav = sections.length > 1
  const rolesSectionTitle = mode === 'roles' ? 'Role permissions' : 'Access control'
  const rolesSectionDescription = mode === 'roles'
    ? 'Compare permissions across roles and open any role to edit its access policy.'
    : 'Manage auth roles and the exact permissions each role grants.'
  const normalizedUserSearch = userSearch.trim().toLowerCase()
  const availableUserRoleOptions = useMemo(() => buildUserRoleOptions(users), [users])
  const visibleUsers = useMemo(
    () => filterAndSortUsers(users, {
      search: normalizedUserSearch,
      statusFilter: userStatusFilter,
      roleFilter: userRoleFilter,
      sortKey: userSortKey,
      sortDirection: userSortDirection
    }),
    [normalizedUserSearch, userRoleFilter, userSortDirection, userSortKey, userStatusFilter, users]
  )
  const hasActiveUserFilters = userStatusFilter !== 'all'
    || userRoleFilter !== ALL_USER_ROLE_FILTER
  const selectedUserRoleLabel = userRoleFilter === ALL_USER_ROLE_FILTER
    ? null
    : userRoleFilter === UNASSIGNED_USER_ROLE_FILTER
      ? 'No roles assigned'
      : availableUserRoleOptions.find((option) => option.value === userRoleFilter)?.label ?? null
  const userPageCount = Math.max(1, Math.ceil(visibleUsers.length / userPageSize))
  const safeUserPage = Math.min(userPage, userPageCount)
  const pagedUsers = useMemo(() => {
    const start = (safeUserPage - 1) * userPageSize
    return visibleUsers.slice(start, start + userPageSize)
  }, [safeUserPage, userPageSize, visibleUsers])
  const usersShowingLabel = useMemo(() => {
    if (visibleUsers.length === 0) {
      return 'No users found'
    }

    const start = (safeUserPage - 1) * userPageSize + 1
    const end = Math.min(safeUserPage * userPageSize, visibleUsers.length)
    return `Showing ${start}-${end} of ${visibleUsers.length}`
  }, [safeUserPage, userPageSize, visibleUsers.length])

  useEffect(() => {
    if (editorState?.mode === 'group' && !editingGroup && groupsQuery.data) {
      setEditorState(null)
    }
  }, [editingGroup, editorState, groupsQuery.data])
  useEffect(() => {
    if (userEditorUserId && !editingUser && usersQuery.data) {
      setUserEditorUserId(null)
    }
  }, [editingUser, userEditorUserId, usersQuery.data])
  useEffect(() => {
    if (editingUser?.canManage === false) {
      setUserEditorUserId(null)
    }
  }, [editingUser])
  useEffect(() => {
    if (serviceAccountEditorState?.mode === 'service-account' && !editingServiceAccount && serviceAccountsQuery.data) {
      setServiceAccountEditorState(null)
    }
  }, [editingServiceAccount, serviceAccountEditorState, serviceAccountsQuery.data])
  useEffect(() => {
    const minutes = parseCustomSessionDurationMinutes(status?.sessionDuration)
    if (minutes != null) {
      setCustomSessionDurationMinutes(String(minutes))
    }
  }, [status?.sessionDuration])
  useEffect(() => {
    if (!status?.sessionDuration) {
      setSessionDurationSelection(null)
      return
    }

    setSessionDurationSelection(
      SESSION_DURATION_OPTIONS.some((option) => option.value === status.sessionDuration)
        ? status.sessionDuration
        : CUSTOM_SESSION_DURATION_OPTION
    )
  }, [status?.sessionDuration])
  useEffect(() => {
    if (userRoleFilter === ALL_USER_ROLE_FILTER || userRoleFilter === UNASSIGNED_USER_ROLE_FILTER) {
      return
    }

    if (!availableUserRoleOptions.some((option) => option.value === userRoleFilter)) {
      setUserRoleFilter(ALL_USER_ROLE_FILTER)
    }
  }, [availableUserRoleOptions, userRoleFilter])
  useEffect(() => {
    setUserPage(1)
  }, [normalizedUserSearch, userRoleFilter, userSortDirection, userSortKey, userStatusFilter, userPageSize])
  useEffect(() => {
    setUserPage((current) => Math.min(current, Math.max(1, Math.ceil(visibleUsers.length / userPageSize))))
  }, [userPageSize, visibleUsers.length])
  useEffect(() => {
    setSupportAccessPermissionsDraft(supportAccessPermissions)
  }, [supportAccessPermissions])

  const editorError = createGroupMutation.error
    ? (isRecentAuthError(createGroupMutation.error) ? null : extractErrorMessage(createGroupMutation.error))
    : updateGroupMutation.error
      ? (isRecentAuthError(updateGroupMutation.error) ? null : extractErrorMessage(updateGroupMutation.error))
      : null
  const deleteError = deleteGroupMutation.error
    ? extractErrorMessage(deleteGroupMutation.error)
    : null
  const userEditorError = updateUserGroupsMutation.error
    ? (isRecentAuthError(updateUserGroupsMutation.error) ? null : extractErrorMessage(updateUserGroupsMutation.error))
    : null
  const userLifecycleError = updateUserMutation.error
    ? extractErrorMessage(updateUserMutation.error)
    : revokeUserSessionMutation.error
      ? extractErrorMessage(revokeUserSessionMutation.error)
        : null
  const userCreationError = createUserMutation.error
    ? (isRecentAuthError(createUserMutation.error) ? null : extractErrorMessage(createUserMutation.error))
    : null
  const userDeleteError = deleteUserMutation.error
    ? extractErrorMessage(deleteUserMutation.error)
    : null
  const serviceAccountEditorError = createServiceAccountMutation.error
    ? (isRecentAuthError(createServiceAccountMutation.error) ? null : extractErrorMessage(createServiceAccountMutation.error))
    : updateServiceAccountMutation.error
      ? (isRecentAuthError(updateServiceAccountMutation.error) ? null : extractErrorMessage(updateServiceAccountMutation.error))
      : null
  const serviceAccountRevokeError = revokeServiceAccountMutation.error
    ? extractErrorMessage(revokeServiceAccountMutation.error)
    : null
  const sessionPolicyError = updateSessionPolicyMutation.error
    ? extractErrorMessage(updateSessionPolicyMutation.error)
    : null

  function openCreateRole() {
    createGroupMutation.reset()
    updateGroupMutation.reset()
    setEditorState({ mode: 'create' })
  }

  function openGroupRole(groupId: string) {
    createGroupMutation.reset()
    updateGroupMutation.reset()
    setEditorState({ mode: 'group', groupId })
  }

  function closeEditor() {
    createGroupMutation.reset()
    updateGroupMutation.reset()
    setEditorState(null)
  }

  function openDeleteGroup(group: AuthGroup) {
    deleteGroupMutation.reset()
    setDeleteTarget(group)
  }

  function closeDeleteDialog() {
    deleteGroupMutation.reset()
    setDeleteTarget(null)
  }

  function openUserEditor(userId: string) {
    updateUserGroupsMutation.reset()
    setUserEditorUserId(userId)
  }

  function openCreateUserDialog() {
    createUserMutation.reset()
    setCreateUserDialogOpen(true)
  }

  function closeCreateUserDialog() {
    createUserMutation.reset()
    setCreateUserDialogOpen(false)
  }

  function closeUserEditor() {
    updateUserMutation.reset()
    updateUserGroupsMutation.reset()
    revokeUserSessionMutation.reset()
    setUserEditorUserId(null)
  }

  function openDeleteUser(user: AuthUser) {
    deleteUserMutation.reset()
    setDeleteUserTarget(user)
  }

  function closeDeleteUserDialog() {
    deleteUserMutation.reset()
    setDeleteUserTarget(null)
  }

  function openCreateServiceAccount() {
    createServiceAccountMutation.reset()
    updateServiceAccountMutation.reset()
    setServiceAccountEditorState({ mode: 'create' })
  }

  function openServiceAccountEditor(serviceAccountId: string) {
    createServiceAccountMutation.reset()
    updateServiceAccountMutation.reset()
    setServiceAccountEditorState({ mode: 'service-account', serviceAccountId })
  }

  function closeServiceAccountEditor() {
    createServiceAccountMutation.reset()
    updateServiceAccountMutation.reset()
    setServiceAccountEditorState(null)
  }

  function closeRevealedServiceAccountToken() {
    setRevealedServiceAccountToken(null)
  }

  function clearUserFilters() {
    setUserStatusFilter('all')
    setUserRoleFilter(ALL_USER_ROLE_FILTER)
  }

  function openSupportPermissionsDialog() {
    updateSupportAccessMutation.reset()
    setSupportAccessPermissionsDraft(supportAccessPermissions)
    setSupportPermissionsDialogOpen(true)
  }

  function closeSupportPermissionsDialog() {
    if (updateSupportAccessMutation.isPending) return
    updateSupportAccessMutation.reset()
    setSupportAccessPermissionsDraft(supportAccessPermissions)
    setSupportPermissionsDialogOpen(false)
  }

  function toggleSupportPermission(permission: Permission, checked: boolean) {
    setSupportAccessPermissionsDraft((current) => {
      if (checked) {
        return current.includes(permission) ? current : [...current, permission]
      }
      return current.filter((entry) => entry !== permission)
    })
  }

  function saveSupportPermissions() {
    updateSupportAccessMutation.mutate({ supportAccessPermissions: supportAccessPermissionsDraft })
  }

  return (
    <Stack spacing={1.5}>
      <>
          {showSectionNav && <SectionNav aria-label="Authentication sections" sections={sections} mb={0} />}

          {(showSessionSecurity || showAuthHealth || showManagementOverview) && (
            <Box id="session-security" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
              <Stack spacing={1.25}>
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  spacing={1.5}
                  justifyContent="space-between"
                  alignItems={{ xs: 'flex-start', md: 'center' }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography level="title-md">Session security</Typography>
                    <Typography level="body-sm" textColor="text.tertiary">
                      Review authentication health and browser-session policy.
                    </Typography>
                  </Box>
                </Stack>

                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={1.5}>
                      {showAuthHealth && (
                        <Stack spacing={1}>
                          <Typography level="title-sm">Auth health</Typography>
                          {authHealthSignals.map((signal) => (
                            <Alert key={signal.id} color={signal.color} variant="soft" startDecorator={readAuthAlertDecorator(signal.color)}>
                              <Stack spacing={0.35}>
                                <Typography level="title-sm">{signal.title}</Typography>
                                <Typography level="body-sm">{signal.detail}</Typography>
                              </Stack>
                            </Alert>
                          ))}
                        </Stack>
                      )}

                      {showManagementOverview && (
                        <AuthManagementOverviewCards
                          userCount={status?.counts.users ?? users.length}
                          roleCount={status?.counts.groups ?? groups.length}
                          permissionCount={permissionDefinitions.length}
                          onOpenUsers={canViewUsers ? onOpenUsers : undefined}
                          onOpenRoles={canViewRoles ? onOpenRoles : undefined}
                        />
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              </Stack>
            </Box>
          )}

          {showSessionDuration && (
            <Box id="session-duration" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
              <Stack spacing={1.25}>
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  spacing={1.5}
                  justifyContent="space-between"
                  alignItems={{ xs: 'flex-start', md: 'center' }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography level="title-md">Session duration</Typography>
                    <Typography level="body-sm" textColor="text.tertiary">
                      Choose how long browser sessions stay active without user activity.
                    </Typography>
                  </Box>
                  {status && (
                    <Chip size="sm" variant="soft" color="primary">
                      Idle timeout: {formatSessionDurationLabel(status.sessionDuration)}
                    </Chip>
                  )}
                </Stack>

                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={1.25}>
                      {sessionPolicyError && (
                        <Alert color="danger" variant="soft">
                          {sessionPolicyError}
                        </Alert>
                      )}

                      <FormControl size="sm" sx={{ maxWidth: 420 }}>
                          <FormLabel>Duration</FormLabel>
                          <Select<SessionDurationSelectValue>
                            value={effectiveSessionDurationSelection}
                            placeholder={statusLoading ? 'Loading…' : 'Select duration'}
                            renderValue={() => (
                              <Stack
                                direction="row"
                                spacing={1.25}
                                alignItems="baseline"
                                justifyContent="space-between"
                                sx={{ width: '100%', minWidth: 0, py: 0.25 }}
                              >
                                <Typography level="body-sm" noWrap title={sessionDurationLabel} sx={{ flexShrink: 0 }}>
                                  {sessionDurationLabel}
                                </Typography>
                                <Typography level="body-xs" textColor="text.tertiary" noWrap title={sessionDurationDetail} sx={{ minWidth: 0, textAlign: 'right' }}>
                                  {sessionDurationDetail}
                                </Typography>
                              </Stack>
                            )}
                            onChange={(_event, value) => {
                              if (!value) return

                              setSessionDurationSelection(value)
                              if (value === CUSTOM_SESSION_DURATION_OPTION || value === status?.sessionDuration) return
                              updateSessionPolicyMutation.mutate(value)
                            }}
                            disabled={!canManageSessionPolicy || !status || statusLoading || updateSessionPolicyMutation.isPending}
                            slotProps={{
                              button: {
                                sx: {
                                  '--Select-minHeight': '56px',
                                  minWidth: 0,
                                  py: 0.5,
                                  textAlign: 'left',
                                  '& > span': {
                                    display: 'flex',
                                    flex: 1,
                                    alignItems: 'center',
                                    minWidth: 0,
                                    textAlign: 'left'
                                  }
                                }
                              }
                            }}
                          >
                            {SESSION_DURATION_OPTIONS.map((option) => (
                              <Option key={option.value} value={option.value} label={option.label}>
                                <Stack
                                  direction="row"
                                  spacing={1.25}
                                  alignItems="baseline"
                                  justifyContent="space-between"
                                  sx={{ width: '100%', minWidth: 0 }}
                                >
                                  <Typography level="body-sm" noWrap sx={{ flexShrink: 0 }}>
                                    {option.label}
                                  </Typography>
                                  <Typography level="body-xs" textColor="text.tertiary" noWrap title={option.detail} sx={{ minWidth: 0, textAlign: 'right' }}>
                                    {option.detail}
                                  </Typography>
                                </Stack>
                              </Option>
                            ))}
                            <Option value={CUSTOM_SESSION_DURATION_OPTION} label="Custom">
                              <Stack
                                direction="row"
                                spacing={1.25}
                                alignItems="baseline"
                                justifyContent="space-between"
                                sx={{ width: '100%', minWidth: 0 }}
                              >
                                <Typography level="body-sm" noWrap sx={{ flexShrink: 0 }}>
                                  Custom
                                </Typography>
                                <Typography level="body-xs" textColor="text.tertiary" noWrap title={customSessionDurationOptionDetail} sx={{ minWidth: 0, textAlign: 'right' }}>
                                  {customSessionDurationOptionDetail}
                                </Typography>
                              </Stack>
                            </Option>
                          </Select>
                        </FormControl>

                      {showCustomSessionDurationControls && (
                        <FormControl size="sm" error={Boolean(customSessionDurationError)} sx={{ maxWidth: 360 }}>
                          <FormLabel>Custom duration (minutes)</FormLabel>
                          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
                            <Input
                              value={customSessionDurationMinutes}
                              onChange={(event) => setCustomSessionDurationMinutes(event.target.value)}
                              placeholder={String(AUTH_SESSION_DURATION_MINUTES_MIN)}
                              slotProps={{
                                input: {
                                  min: AUTH_SESSION_DURATION_MINUTES_MIN,
                                  step: 1,
                                  type: 'number'
                                }
                              }}
                            />
                            <Button
                              size="sm"
                              variant="soft"
                              color="primary"
                              onClick={() => {
                                if (!customSessionDurationValue || customSessionDurationValue === status?.sessionDuration) return
                                updateSessionPolicyMutation.mutate(customSessionDurationValue)
                              }}
                              disabled={!canManageSessionPolicy || !status || statusLoading || updateSessionPolicyMutation.isPending || !customSessionDurationValue || customSessionDurationValue === status?.sessionDuration}
                            >
                              Apply custom
                            </Button>
                          </Stack>
                        </FormControl>
                      )}

                      {showCustomSessionDurationControls && (
                        <Typography level="body-xs" textColor={customSessionDurationError ? 'danger.600' : 'text.tertiary'}>
                          {customSessionDurationError ?? `Use any whole-minute duration of at least ${AUTH_SESSION_DURATION_MINUTES_MIN} minutes.`}
                        </Typography>
                      )}
                      <Typography level="body-xs" textColor="text.tertiary">
                        Active browser sessions extend this timeout as users make authenticated requests. Sensitive actions can still require recent verification.
                      </Typography>
                    </Stack>
                  </CardContent>
                </Card>
              </Stack>
            </Box>
          )}

          {showUsers && (
            <Box id="users" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
              <Stack spacing={1.25}>
                <Stack spacing={0.5}>
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    justifyContent="space-between"
                    alignItems="center"
                    sx={{ flexWrap: 'wrap' }}
                  >
                    <Typography level="title-md">Users</Typography>
                    {canCreateUsers && (
                      <Button size="sm" variant="solid" color="primary" onClick={openCreateUserDialog}>
                        Create user
                      </Button>
                    )}
                  </Stack>
                </Stack>

                {canViewUsers && !usersQuery.isLoading && !usersQuery.error && users.length > 0 && (
                  <Stack spacing={1.25}>
                    <Stack spacing={1}>
                      <DirectoryPrimaryToolbar
                        searchValue={userSearch}
                        onSearchChange={setUserSearch}
                        searchPlaceholder="Search by name, email, or role"
                        searchAriaLabel="Filter users"
                        filtersButton={(
                          <DirectoryFiltersButton
                            activeCount={Number(userStatusFilter !== 'all') + Number(userRoleFilter !== ALL_USER_ROLE_FILTER)}
                            onClick={() => setUserFiltersDialogOpen(true)}
                          />
                        )}
                        pageSizeValue={userPageSize}
                        pageSizeOptions={USER_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} per page` }))}
                        onPageSizeChange={setUserPageSize}
                        pageSizeAriaLabel="Users per page"
                        pageSizeRenderValue={(value) => `${value} per page`}
                        sortValue={userSortKey}
                        sortOptions={USER_SORT_OPTIONS}
                        onSortValueChange={setUserSortKey}
                        sortDirection={userSortDirection}
                        onSortDirectionChange={setUserSortDirection}
                        sortAriaLabel="Sort users by"
                        viewMode={userViewMode}
                        onViewModeChange={setUserViewMode}
                        disableIconModeOnMobile
                        sortMinWidth={150}
                      />
                    </Stack>

                    {hasActiveUserFilters && (
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        {userStatusFilter !== 'all' && (
                          <Chip size="sm" variant="soft" color="neutral">
                            {USER_STATUS_OPTIONS.find((option) => option.value === userStatusFilter)?.label}
                          </Chip>
                        )}
                        {selectedUserRoleLabel && (
                          <Chip size="sm" variant="soft" color="neutral">
                            {selectedUserRoleLabel}
                          </Chip>
                        )}
                        <Button size="sm" variant="plain" color="neutral" onClick={clearUserFilters}>
                          Clear filters
                        </Button>
                      </Stack>
                    )}

                    <DirectoryFiltersDialog
                      open={userFiltersDialogOpen}
                      title="User filters"
                      onClose={() => setUserFiltersDialogOpen(false)}
                      onClear={clearUserFilters}
                      clearDisabled={!hasActiveUserFilters}
                    >
                      <FormControl>
                        <FormLabel>Status</FormLabel>
                        <Select<UserStatusFilter>
                          size="sm"
                          value={userStatusFilter}
                          onChange={(_event, value) => value && setUserStatusFilter(value)}
                        >
                          {USER_STATUS_OPTIONS.map((option) => (
                            <Option key={option.value} value={option.value}>{option.label}</Option>
                          ))}
                        </Select>
                      </FormControl>
                      <FormControl>
                        <FormLabel>Role</FormLabel>
                        <Select<string>
                          size="sm"
                          value={userRoleFilter}
                          onChange={(_event, value) => value && setUserRoleFilter(value)}
                        >
                          <Option value={ALL_USER_ROLE_FILTER}>All roles</Option>
                          <Option value={UNASSIGNED_USER_ROLE_FILTER}>No roles assigned</Option>
                          {availableUserRoleOptions.map((option) => (
                            <Option key={option.value} value={option.value}>{option.label}</Option>
                          ))}
                        </Select>
                      </FormControl>
                    </DirectoryFiltersDialog>
                  </Stack>
                )}

                {!canViewUsers ? (
                  <Card variant="outlined">
                    <CardContent>
                      <Typography level="body-sm" textColor="text.tertiary">
                        Viewing existing users requires the View Users permission.
                      </Typography>
                    </CardContent>
                  </Card>
                ) : usersQuery.isLoading ? (
                  <Typography level="body-sm" textColor="text.tertiary">
                    Loading users…
                  </Typography>
                ) : usersQuery.error ? (
                  <Alert color="danger" variant="soft">
                    {extractErrorMessage(usersQuery.error)}
                  </Alert>
                ) : users.length === 0 ? (
                  <Card variant="outlined">
                    <CardContent>
                      <Typography level="body-sm" textColor="text.tertiary">
                        No auth users exist yet.
                      </Typography>
                    </CardContent>
                  </Card>
                ) : visibleUsers.length === 0 ? (
                  <Card variant="outlined">
                    <CardContent>
                      <Stack spacing={1}>
                        <Typography level="body-sm" textColor="text.tertiary">
                          No users matched the current search or filters.
                        </Typography>
                        {hasActiveUserFilters && (
                          <Box>
                            <Button size="sm" variant="soft" color="neutral" onClick={clearUserFilters}>
                              Clear filters
                            </Button>
                          </Box>
                        )}
                      </Stack>
                    </CardContent>
                  </Card>
                ) : (
                  <PaginatedSection
                    showingLabel={usersShowingLabel}
                    previousDisabled={safeUserPage <= 1}
                    nextDisabled={safeUserPage >= userPageCount}
                    onPrevious={() => setUserPage((current) => Math.max(1, current - 1))}
                    onNext={() => setUserPage((current) => Math.min(userPageCount, current + 1))}
                    spacing={1.25}
                  >
                    <Box
                      sx={effectiveUserViewMode === 'icon'
                        ? {
                          display: 'grid',
                          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                          gap: 1.25,
                          alignItems: 'stretch'
                        }
                        : {
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr)',
                          gap: 1.25
                        }}
                    >
                      {pagedUsers.map((user) => {
                        const canOpenUser = Boolean(
                          user.canManage !== false
                          && (canEditUsers || canDisableUserSignIn || canDeleteUsers || canAssignUserRoles || canViewUserSessions || canViewUserPasskeys)
                        )
                        return (
                          <Card
                            key={user.id}
                            component={canOpenUser ? 'button' : 'div'}
                            type={canOpenUser ? 'button' : undefined}
                            variant="outlined"
                            aria-label={canOpenUser ? `Manage ${getUserDisplayLabel(user)}` : undefined}
                            onClick={canOpenUser ? () => openUserEditor(user.id) : undefined}
                            sx={canOpenUser ? {
                              p: 2,
                              textAlign: 'left',
                              cursor: 'pointer',
                              transition: 'background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
                              '&:hover': {
                                backgroundColor: 'background.level1',
                                borderColor: 'primary.softColor'
                              },
                              '&:focus-visible': {
                                outline: '2px solid',
                                outlineColor: 'focusVisible',
                                outlineOffset: '2px'
                              }
                            } : undefined}
                          >
                            <CardContent sx={canOpenUser ? { p: 0 } : undefined}>
                              <Box
                                sx={{
                                  display: 'grid',
                                  gap: 1.5,
                                  gridTemplateColumns: canOpenUser
                                    ? 'minmax(0, 1fr) auto'
                                    : { xs: '1fr', md: 'minmax(0, 1fr) auto' },
                                  alignItems: 'center'
                                }}
                              >
                                <Stack spacing={0.6} sx={{ minWidth: 0 }}>
                                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                                    <Typography level="title-sm" sx={{ minWidth: 0 }}>{getUserDisplayLabel(user)}</Typography>
                                    {user.loginDisabled && <Chip size="sm" variant="soft" color="warning">Sign-in disabled</Chip>}
                                  </Stack>
                                  <Typography level="body-sm" textColor="text.tertiary">
                                    {user.displayName?.trim() ? user.email : 'No display name set'}
                                  </Typography>
                                  <Typography level="body-xs" textColor="text.tertiary">
                                    Added {formatDateTime(user.createdAt)}
                                  </Typography>

                                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                                    {user.groups.length > 0
                                      ? user.groups.map((group) => (
                                        <Chip key={`${user.id}-${group.id}`} size="sm" variant="outlined" color="neutral">
                                          {group.name}
                                        </Chip>
                                      ))
                                      : (
                                        <Chip size="sm" variant="outlined" color="neutral">
                                          No roles assigned
                                        </Chip>
                                      )}
                                    <Chip size="sm" variant="soft" color="success">
                                      {user.passkeyCount} passkey{user.passkeyCount === 1 ? '' : 's'}
                                    </Chip>
                                  </Stack>
                                </Stack>

                                <Box sx={{ alignSelf: 'center', justifySelf: 'end' }}>
                                  {canOpenUser ? (
                                    <Typography
                                      aria-hidden="true"
                                      level="title-lg"
                                      textColor="text.tertiary"
                                      sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
                                    >
                                      <KeyboardArrowRightRoundedIcon />
                                    </Typography>
                                  ) : user.canManage === false ? (
                                    <Chip size="sm" variant="soft" color="warning">Higher access</Chip>
                                  ) : null}
                                </Box>
                              </Box>
                            </CardContent>
                          </Card>
                        )
                      })}
                    </Box>
                  </PaginatedSection>
              )}
              </Stack>
            </Box>
          )}

          {showRoles && (
            <Box id="roles" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
              <Stack spacing={1.25}>
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  spacing={1.5}
                  justifyContent="space-between"
                  alignItems={{ xs: 'flex-start', md: 'center' }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography level="title-md">{rolesSectionTitle}</Typography>
                    <Typography level="body-sm" textColor="text.tertiary">
                      {rolesSectionDescription}
                    </Typography>
                  </Box>

                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    <Chip size="sm" variant="soft" color="primary">
                      {status?.counts.groups ?? groups.length} role{(status?.counts.groups ?? groups.length) === 1 ? '' : 's'}
                    </Chip>
                    <Chip size="sm" variant="soft" color="neutral">
                      {permissionDefinitions.length} permission{permissionDefinitions.length === 1 ? '' : 's'}
                    </Chip>
                    {canCreateRoles && (
                      <Button
                        size="sm"
                        variant="solid"
                        color="primary"
                        onClick={openCreateRole}
                        disabled={permissionDefinitions.length === 0}
                      >
                        Create role
                      </Button>
                    )}
                  </Stack>
                </Stack>

              {statusLoading && !status && (
                <Typography level="body-sm" textColor="text.tertiary">
                  Loading auth access policy…
                </Typography>
              )}

              {statusError && !status && (
                <Alert color="danger" variant="soft">
                  {statusError}
                </Alert>
              )}

              {!canViewRoles ? (
                <Card variant="outlined">
                  <CardContent>
                    <Typography level="body-sm" textColor="text.tertiary">
                      Viewing existing roles requires the View Roles permission.
                    </Typography>
                  </CardContent>
                </Card>
              ) : groupsQuery.isLoading ? (
                <Typography level="body-sm" textColor="text.tertiary">
                  Loading roles…
                </Typography>
              ) : groupsQuery.error ? (
                <Alert color="danger" variant="soft">
                  {extractErrorMessage(groupsQuery.error)}
                </Alert>
              ) : groups.length === 0 ? (
                <Card variant="outlined">
                  <CardContent>
                    <Typography level="body-sm" textColor="text.tertiary">
                      No roles exist yet. Create one to start assigning reusable access policy.
                    </Typography>
                  </CardContent>
                </Card>
              ) : permissionDefinitions.length === 0 ? (
                <Card variant="outlined">
                  <CardContent>
                    <Typography level="body-sm" textColor="text.tertiary">
                      No permissions are available yet.
                    </Typography>
                  </CardContent>
                </Card>
              ) : (
                <RolePermissionsMatrix
                  groups={groups}
                  permissionSections={permissionSections}
                  permissionLabelByKey={permissionLabelByKey}
                  canDeleteRoles={canDeleteRoles}
                  onOpenRole={openGroupRole}
                  onDeleteRole={openDeleteGroup}
                />
              )}
              </Stack>
            </Box>
          )}

          {showServiceAccounts && (
            <Box id="service-accounts" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
              <Stack spacing={1.25}>
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  spacing={1.5}
                  justifyContent="space-between"
                  alignItems={{ xs: 'flex-start', md: 'center' }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography level="title-md">Service accounts</Typography>
                    <Typography level="body-sm" textColor="text.tertiary">
                      Create machine identities with role-based permissions for automation and integrations.
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    <Chip size="sm" variant="soft" color="neutral">
                      {status?.counts.serviceAccounts ?? serviceAccounts.length} account{(status?.counts.serviceAccounts ?? serviceAccounts.length) === 1 ? '' : 's'}
                    </Chip>
                    {canCreateServiceAccounts && (
                      <Button size="sm" variant="solid" color="primary" onClick={openCreateServiceAccount}>
                        Create service account
                      </Button>
                    )}
                  </Stack>
                </Stack>

                {serviceAccountRevokeError && (
                  <Alert color="danger" variant="soft">
                    {serviceAccountRevokeError}
                  </Alert>
                )}

                {!canViewServiceAccounts ? (
                  <Card variant="outlined">
                    <CardContent>
                      <Typography level="body-sm" textColor="text.tertiary">
                        Viewing existing service accounts requires the View Service Accounts permission.
                      </Typography>
                    </CardContent>
                  </Card>
                ) : serviceAccountsQuery.isLoading ? (
                  <Typography level="body-sm" textColor="text.tertiary">
                    Loading service accounts…
                  </Typography>
                ) : serviceAccountsQuery.error ? (
                  <Alert color="danger" variant="soft">
            {extractErrorMessage(serviceAccountsQuery.error)}
          </Alert>
        ) : serviceAccounts.length === 0 ? (
          <Card variant="outlined">
            <CardContent>
              <Typography level="body-sm" textColor="text.tertiary">
                No service accounts yet. Create one to issue a token for automation.
              </Typography>
            </CardContent>
          </Card>
        ) : (
          <Stack spacing={1.25}>
            {serviceAccounts.map((serviceAccount) => {
              const isRevoking = revokeServiceAccountMutation.isPending && revokeServiceAccountMutation.variables === serviceAccount.id

              return (
                <Card key={serviceAccount.id} variant="outlined">
                  <CardContent>
                    <Stack spacing={1.25}>
                      <Stack
                        direction={{ xs: 'column', md: 'row' }}
                        spacing={1.5}
                        justifyContent="space-between"
                        alignItems={{ xs: 'flex-start', md: 'flex-start' }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                            <Typography level="title-sm">{serviceAccount.name}</Typography>
                            {serviceAccount.revokedAt && <Chip size="sm" variant="soft" color="danger">Revoked</Chip>}
                          </Stack>
                          <Typography level="body-sm" textColor="text.tertiary">
                            Token prefix: {serviceAccount.tokenPrefix}
                          </Typography>
                          <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                            {serviceAccount.revokedAt
                              ? `Revoked ${formatDateTime(serviceAccount.revokedAt)}`
                              : serviceAccount.lastUsedAt
                                ? `Last used ${formatDateTime(serviceAccount.lastUsedAt)}`
                                : 'Never used'}
                          </Typography>
                        </Box>

                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {(canEditServiceAccounts || canAssignServiceAccountRoles) && (
                            <Button
                              size="sm"
                              variant="soft"
                              color="neutral"
                              disabled={!serviceAccount.canManage}
                              onClick={() => openServiceAccountEditor(serviceAccount.id)}
                            >
                              {serviceAccount.canManage ? 'Edit access' : 'Higher access'}
                            </Button>
                          )}
                          {!serviceAccount.revokedAt && canRevokeServiceAccounts && serviceAccount.canManage && (
                            <Button
                              size="sm"
                              variant="plain"
                              color="danger"
                              loading={isRevoking}
                              onClick={() => revokeServiceAccountMutation.mutate(serviceAccount.id)}
                            >
                              Revoke
                            </Button>
                          )}
                        </Stack>
                      </Stack>

                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        <Chip size="sm" variant="soft" color="neutral">
                          {serviceAccount.groups.length} role{serviceAccount.groups.length === 1 ? '' : 's'}
                        </Chip>
                        <Chip size="sm" variant="soft" color="neutral">
                          Created {formatDateTime(serviceAccount.createdAt)}
                        </Chip>
                      </Stack>

                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        {serviceAccount.groups.length > 0
                          ? serviceAccount.groups.map((group) => (
                            <Chip key={`${serviceAccount.id}-${group.id}`} size="sm" variant="outlined" color="neutral">
                              {group.name}
                            </Chip>
                          ))
                          : (
                            <Chip size="sm" variant="outlined" color="neutral">
                              No roles assigned
                            </Chip>
                          )}
                      </Stack>
                    </Stack>
                  </CardContent>
                </Card>
              )
            })}
          </Stack>
        )}
              </Stack>
            </Box>
          )}

          {showSupportControls && hasTenantScopedSettings && (
            <Box id="support-access" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
              <Stack spacing={1.25}>
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  spacing={1.5}
                  justifyContent="space-between"
                  alignItems={{ xs: 'flex-start', md: 'center' }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography level="title-md">Support access</Typography>
                    <Typography level="body-sm" textColor="text.tertiary">
                      Choose whether support users can enter this workspace and what they can do while helping.
                    </Typography>
                  </Box>
                  <Chip size="sm" variant="soft" color={supportAccessEnabled ? 'success' : 'warning'}>
                    {supportAccessEnabled ? 'Enabled' : 'Disabled'}
                  </Chip>
                </Stack>

                {supportAccessError && (
                  <Alert color="danger" variant="soft">
                    {supportAccessError}
                  </Alert>
                )}

                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={1.25}>
                      <Typography level="body-sm">
                        {supportAccessEnabled
                          ? 'Support users can currently enter this workspace to assist with setup and troubleshooting.'
                          : 'Support users are currently blocked from entering this workspace.'}
                      </Typography>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
                        <Button
                          size="sm"
                          variant={supportAccessEnabled ? 'soft' : 'solid'}
                          color={supportAccessEnabled ? 'warning' : 'success'}
                          loading={updateSupportAccessMutation.isPending || generalSettingsQuery.isLoading}
                          disabled={!canManageSupportAccess || generalSettingsQuery.isLoading || supportAccessDisableBlockedByMissingAdmin || supportAccessDisableWaitingForUsers}
                          onClick={() => updateSupportAccessMutation.mutate({ supportAccessEnabled: !supportAccessEnabled })}
                        >
                          {supportAccessEnabled ? 'Disable support access' : 'Enable support access'}
                        </Button>
                        <Button
                          size="sm"
                          variant={canManageSupportAccess ? 'soft' : 'plain'}
                          disabled={generalSettingsQuery.isLoading}
                          onClick={openSupportPermissionsDialog}
                        >
                          {canManageSupportAccess ? 'Edit allowed actions' : 'View allowed actions'}
                        </Button>
                        {!canManageSupportAccess && (
                          <Typography level="body-xs" textColor="text.tertiary">
                            Requires the Manage Support Access permission.
                          </Typography>
                        )}
                      </Stack>

                      {supportAccessDisableBlockedByMissingAdmin && (
                        <Typography level="body-xs" textColor="warning.500">
                          Create or re-enable an Admin user before disabling support access.
                        </Typography>
                      )}

                      {supportAccessPermissions.length === 0 && (
                        <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                          Support users currently have no allowed actions in this workspace.
                        </Alert>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              </Stack>
            </Box>
          )}

          {editorState && permissionDefinitions.length > 0 && (
        <AuthGroupEditorDialog
          group={editingGroup}
          creating={editorState.mode === 'create'}
          permissionSections={permissionSections}
              assignablePermissionSet={assignablePermissionSet}
              canEditRoleDetails={canEditRoles}
              canAssignRolePermissions={canAssignRolePermissions}
          error={editorError}
          saving={createGroupMutation.isPending || updateGroupMutation.isPending}
          onClose={closeEditor}
          onCreate={(body) => createGroupMutation.mutate(body)}
          onUpdate={(groupId, body) => updateGroupMutation.mutate({ groupId, body })}
        />
          )}

          {deleteTarget && (
        <DeleteAuthGroupDialog
          group={deleteTarget}
          error={deleteError}
          deleting={deleteGroupMutation.isPending}
          onClose={closeDeleteDialog}
          onConfirm={() => deleteGroupMutation.mutate(deleteTarget.id)}
        />
          )}

          {editingUser && (
        <AuthUserManagementDialog
          user={editingUser}
          authProviders={authProviders}
          groups={groups}
          canDisableUserSignIn={canDisableUserSignIn}
          canDeleteUsers={canDeleteUsers}
          canAssignUserRoles={canAssignUserRoles}
          canViewRoles={canViewRoles}
          canViewUserSessions={canViewUserSessions}
          canRevokeUserSessions={canRevokeUserSessions}
          canSendUserInvites={canEditUsers}
          canViewUserPasskeys={canViewUserPasskeys}
          canEditUserPasskeys={canEditUserPasskeys}
          canRevokeUserPasskeys={canRevokeUserPasskeys}
          isOnlyEnabledAdmin={enabledAdminUserIds.length === 1 && enabledAdminUserIds[0] === editingUser.id}
          sessions={userSessionsQuery.data?.sessions ?? []}
          sessionsLoading={userSessionsQuery.isLoading}
          sessionsError={userSessionsQuery.error ? extractErrorMessage(userSessionsQuery.error) : null}
          accessError={userEditorError}
          lifecycleError={userLifecycleError}
          deleteError={userDeleteError}
          savingAccess={updateUserGroupsMutation.isPending}
          mutatingLifecycle={updateUserMutation.isPending || revokeUserSessionMutation.isPending || deleteUserMutation.isPending}
          revokingSessionId={revokeUserSessionMutation.isPending ? revokeUserSessionMutation.variables?.sessionId ?? null : null}
          onClose={closeUserEditor}
          onSubmit={(groupIds) => updateUserGroupsMutation.mutate({
            userId: editingUser.id,
            body: { groupIds }
          })}
          onToggleLoginDisabled={(loginDisabled) => updateUserMutation.mutate({
            userId: editingUser.id,
            body: { loginDisabled }
          })}
          onRevokeSession={(sessionId) => revokeUserSessionMutation.mutate({ userId: editingUser.id, sessionId })}
          onDeleteRequest={() => openDeleteUser(editingUser)}
        />
          )}

          {deleteUserTarget && (
        <DeleteAuthUserDialog
          user={deleteUserTarget}
          error={userDeleteError}
          deleting={deleteUserMutation.isPending}
          onClose={closeDeleteUserDialog}
          onConfirm={() => deleteUserMutation.mutate(deleteUserTarget.id)}
        />
          )}

          {createUserDialogOpen && (
        <CreateAuthUserDialog
          groups={groups}
              canAssignUserRoles={canAssignUserRoles}
          error={userCreationError}
          saving={createUserMutation.isPending}
          onClose={closeCreateUserDialog}
          onCreate={(body) => createUserMutation.mutate(body)}
        />
          )}

          {serviceAccountEditorState && (
        <AuthServiceAccountEditorDialog
          serviceAccount={editingServiceAccount}
          groups={groups}
          creating={serviceAccountEditorState.mode === 'create'}
              canEditServiceAccountName={canEditServiceAccounts}
              canAssignServiceAccountRoles={canAssignServiceAccountRoles}
          error={serviceAccountEditorError}
          saving={createServiceAccountMutation.isPending || updateServiceAccountMutation.isPending}
          onClose={closeServiceAccountEditor}
          onCreate={(body) => createServiceAccountMutation.mutate(body)}
          onUpdate={(serviceAccountId, body) => updateServiceAccountMutation.mutate({ serviceAccountId, body })}
        />
          )}

      </>

      {revealedServiceAccountToken && (
        <CreatedServiceAccountTokenDialog
          revealedToken={revealedServiceAccountToken}
          onClose={closeRevealedServiceAccountToken}
        />
      )}

      <SupportAccessPermissionsDialog
        open={supportPermissionsDialogOpen}
        supportAccessEnabled={supportAccessEnabled}
        permissionSections={permissionSections}
        selectedPermissions={supportAccessPermissionsDraft}
        changed={supportAccessPermissionsChanged}
        canManageSupportAccess={canManageSupportAccess}
        saving={updateSupportAccessMutation.isPending}
        error={supportAccessError}
        onClose={closeSupportPermissionsDialog}
        onTogglePermission={toggleSupportPermission}
        onSave={saveSupportPermissions}
      />

      <ProviderRecentVerificationDialog
        open={pendingSensitiveAction != null}
        title={pendingSensitiveAction?.type === 'update-support-access' ? 'Verify to change support access' : 'Verify to change auth access'}
        description={pendingSensitiveAction?.type === 'update-support-access'
          ? 'For security, confirm it is really you before changing support access.'
          : 'For security, confirm it is really you before changing role assignments or permission policy.'}
        email={actorEmail}
        authProviders={authProviders}
        onClose={closeRecentVerification}
        onVerified={handleRecentVerificationSuccess}
      />
    </Stack>
  )
}

function readAuthAlertDecorator(color: 'danger' | 'warning' | 'success' | 'primary' | 'neutral') {
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

// eslint-disable-next-line react-refresh/only-export-components -- exported for focused unit coverage.
export function shouldAutoOpenCreatedUserEditor(users: AuthUser[], createdUserId: string): boolean {
  const createdUser = users.find((user) => user.id === createdUserId)
  return createdUser?.canManage !== false
}

function SupportAccessPermissionsDialog({
  open,
  supportAccessEnabled,
  permissionSections,
  selectedPermissions,
  changed,
  canManageSupportAccess,
  saving,
  error,
  onClose,
  onTogglePermission,
  onSave
}: {
  open: boolean
  supportAccessEnabled: boolean
  permissionSections: PermissionSection[]
  selectedPermissions: Permission[]
  changed: boolean
  canManageSupportAccess: boolean
  saving: boolean
  error: string | null
  onClose: () => void
  onTogglePermission: (permission: Permission, checked: boolean) => void
  onSave: () => void
}) {
  const selectedCount = selectedPermissions.length
  const [prerequisitePrompt, setPrerequisitePrompt] = useState<PermissionPrerequisitePrompt | null>(null)

  const allDefinitions = useMemo(
    () => permissionSections.flatMap((s) => s.permissions),
    [permissionSections]
  )
  const permissionLabelMap = useMemo(
    () => new Map(allDefinitions.map((d) => [d.key, d.label])),
    [allDefinitions]
  )
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())

  function handleToggle(permission: Permission, checked: boolean, sectionKeys: Permission[], anchorEl: PermissionPromptAnchor | null) {
    if (checked) {
      const missing = resolveMissingPrerequisites(permission, selectedPermissions)
      const crossSectionMissing = missing.filter((entry) => !sectionKeys.includes(entry))
      if (crossSectionMissing.length > 0) {
        setPrerequisitePrompt({ action: 'add', anchorEl, permission, affectedPermissions: missing })
        return
      }
      if (missing.length > 0) {
        for (const entry of [permission, ...missing]) {
          onTogglePermission(entry, true)
        }
        return
      }
    } else {
      const dependentRemovals = resolveDependentRemovals(permission, selectedPermissions)
      if (dependentRemovals.length > 0) {
        setPrerequisitePrompt({ action: 'remove', anchorEl, permission, affectedPermissions: dependentRemovals })
        return
      }
    }
    onTogglePermission(permission, checked)
  }

  function confirmPrerequisites() {
    if (!prerequisitePrompt) return
    const { action, permission, affectedPermissions } = prerequisitePrompt
    onTogglePermission(permission, action === 'add')
    for (const entry of affectedPermissions) {
      onTogglePermission(entry, action === 'add')
    }
    setPrerequisitePrompt(null)
  }

  return (
    <Modal open={open} onClose={onClose}>
      <>
        <ScrollableModalDialog sx={{ width: 'min(880px, 100%)' }}>
          <ModalClose disabled={saving} />
          <DialogTitle>Allowed support actions</DialogTitle>
          <DialogContent>
            <Stack spacing={0.75}>
              <Typography level="body-sm" textColor="text.tertiary">
                Choose the actions support users can take while they are helping inside this workspace.
              </Typography>
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip size="sm" variant="soft" color={selectedCount > 0 ? 'primary' : 'neutral'}>
                  {selectedCount} allowed
                </Chip>
                {!canManageSupportAccess && (
                  <Chip size="sm" variant="soft" color="warning">
                    View only
                  </Chip>
                )}
              </Stack>
            </Stack>
          </DialogContent>

          <ScrollableDialogBody>
            <Stack spacing={1.25}>
              {error && (
                <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                  {error}
                </Alert>
              )}

              {!supportAccessEnabled && (
                <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                  Support access is currently disabled. These action choices will apply the next time you enable it.
                </Alert>
              )}

              {permissionSections.length === 0 ? (
                <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                  No support-manageable actions are available in this workspace yet.
                </Alert>
              ) : permissionSections.map((section) => {
                const isCollapsed = collapsedSections.has(section.title)
                const selectedInSection = section.permissions.filter((permission) => selectedPermissions.includes(permission.key)).length
                const tree = buildPermissionTree(section.permissions)
                const sectionKeys = section.permissions.map((d) => d.key)
                const allAssignable = new Set(section.permissions.map((d) => d.key))

                return (
                  <DialogSection
                    key={section.title}
                    title={section.title}
                    description={`${selectedInSection} of ${section.permissions.length} action${section.permissions.length === 1 ? '' : 's'} allowed.${selectedInSection !== section.permissions.length ? ` ${selectedInSection} selected.` : ''}`}
                  >
                    <Stack spacing={1.25}>
                      <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                        <Button
                          size="sm"
                          variant="plain"
                          color="neutral"
                          onClick={() => setCollapsedSections((current) => toggleCollapsedSection(current, section.title))}
                          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${section.title} actions`}
                          startDecorator={isCollapsed ? <KeyboardArrowRightRoundedIcon /> : <KeyboardArrowDownRoundedIcon />}
                          sx={{ px: 0, justifyContent: 'flex-start', minWidth: 0 }}
                        >
                          {isCollapsed ? 'Show actions' : 'Hide actions'}
                        </Button>
                      </Box>

                      {!isCollapsed && (
                        <Stack spacing={0.5}>
                          {tree.map((node) => (
                            <PermissionTreeNode
                              key={node.definition.key}
                              node={node}
                              depth={0}
                              selectedPermissions={selectedPermissions}
                              disabled={!canManageSupportAccess || saving}
                              assignablePermissionSet={allAssignable}
                              permissionLabelMap={permissionLabelMap}
                              sectionKeys={sectionKeys}
                              onToggle={(permission, checked, anchorEl) => handleToggle(permission, checked, sectionKeys, anchorEl)}
                            />
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  </DialogSection>
                )
              })}
            </Stack>
          </ScrollableDialogBody>

          <DialogActions>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={onSave} loading={saving} disabled={!canManageSupportAccess || !changed}>
              Save actions
            </Button>
          </DialogActions>
        </ScrollableModalDialog>

        <PermissionDependencyPopover
          prompt={prerequisitePrompt}
          permissionLabelMap={permissionLabelMap}
          confirmLabel={prerequisitePrompt?.action === 'remove' ? 'Remove all' : 'Grant all'}
          onClose={() => setPrerequisitePrompt(null)}
          onConfirm={confirmPrerequisites}
        />
      </>
    </Modal>
  )
}

function CreateAuthUserDialog({
  groups,
  canAssignUserRoles,
  error,
  saving,
  onClose,
  onCreate
}: {
  groups: AuthGroup[]
  canAssignUserRoles: boolean
  error: string | null
  saving: boolean
  onClose: () => void
  onCreate: (body: CreateManagedAuthUserRequest) => void
}) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])

  const normalizedEmail = email.trim()
  const normalizedDisplayName = displayName.trim() ? displayName.trim() : null
  const sortedSelectedGroupIds = useMemo(
    () => [...selectedGroupIds].sort(),
    [selectedGroupIds]
  )
  const orderedGroups = useMemo(() => orderGroupsForDisplay(groups), [groups])

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => {
      if (checked) {
        return current.includes(groupId) ? current : [...current, groupId]
      }
      return current.filter((entry) => entry !== groupId)
    })
  }

  function handleSubmit() {
    if (normalizedEmail.length === 0) return
    onCreate({
      email: normalizedEmail,
      displayName: normalizedDisplayName,
      groupIds: sortedSelectedGroupIds
    })
  }

  return (
    <Modal open onClose={() => !saving && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(720px, 100%)' }}>
        <ModalClose disabled={saving} />
        <DialogTitle>Create user</DialogTitle>
        <DialogContent>
          <Stack spacing={0.75}>
            <Typography level="body-sm" textColor="text.tertiary">
              Create an auth user account and assign its initial roles. Provider-specific setup actions are available after the user is created.
            </Typography>
          </Stack>
        </DialogContent>

        <ScrollableDialogBody>
          <Stack spacing={2}>
            <DialogSection title="User details">
              <Stack spacing={1.25}>
                <FormControl required>
                  <FormLabel>Email</FormLabel>
                  <Input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={saving}
                    placeholder="name@example.com"
                  />
                </FormControl>

                <FormControl>
                  <FormLabel>Display name</FormLabel>
                  <Input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    disabled={saving}
                    placeholder="Optional"
                  />
                </FormControl>
              </Stack>
            </DialogSection>

            {error && (
              <Alert color="danger" variant="soft">
                {error}
              </Alert>
            )}

            {groups.length === 0 ? (
              <Alert color="warning" variant="soft">
                No roles exist yet. This user will be created without any assigned access until you add roles.
              </Alert>
            ) : !canAssignUserRoles ? (
              <Alert color="neutral" variant="soft">
                Assigning roles during user creation requires the Assign User Roles permission.
              </Alert>
            ) : (
              <DialogSection
                title="Initial roles"
                description="Choose the roles this user should start with."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1}>
                    {orderedGroups.map((group) => (
                      <Checkbox
                        key={group.id}
                        checked={sortedSelectedGroupIds.includes(group.id)}
                        disabled={saving || !group.canManage}
                        onChange={(event) => toggleGroup(group.id, event.target.checked)}
                        label={(
                          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                              <Typography level="title-sm">{group.name}</Typography>
                              {group.isSystem && <Chip size="sm" variant="soft" color="primary">Built-in</Chip>}
                              {!group.canManage && <Chip size="sm" variant="soft" color="warning">Higher access</Chip>}
                            </Stack>
                            <Typography level="body-xs" textColor="text.tertiary">
                              {group.description?.trim() || 'No description yet.'}
                            </Typography>
                          </Stack>
                        )}
                        sx={{ alignItems: 'flex-start', '--Checkbox-gap': '0.75rem' }}
                      />
                    ))}
                  </Stack>
                </Sheet>
              </DialogSection>
            )}
          </Stack>
        </ScrollableDialogBody>

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={normalizedEmail.length === 0}>
            Create user
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

function AuthGroupEditorDialog({
  group,
  creating,
  permissionSections,
  assignablePermissionSet,
  canEditRoleDetails,
  canAssignRolePermissions,
  error,
  saving,
  onClose,
  onCreate,
  onUpdate
}: {
  group: AuthGroup | null
  creating: boolean
  permissionSections: PermissionSection[]
  assignablePermissionSet: ReadonlySet<Permission>
  canEditRoleDetails: boolean
  canAssignRolePermissions: boolean
  error: string | null
  saving: boolean
  onClose: () => void
  onCreate: (body: CreateAuthGroupRequest) => void
  onUpdate: (groupId: string, body: UpdateAuthGroupRequest) => void
}) {
  const permissionDefinitions = permissionSections.flatMap((section) => section.permissions)
  const permissionOrder = useMemo(
    () => new Map(permissionDefinitions.map((definition, index) => [definition.key, index] as const)),
    [permissionDefinitions]
  )
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())
  const [prerequisitePrompt, setPrerequisitePrompt] = useState<PermissionPrerequisitePrompt | null>(null)
  useEffect(() => {
    if (creating) {
      setName('')
      setDescription('')
      setPermissions([])
      return
    }

    if (!group) return
    setName(group.name)
    setDescription(group.description ?? '')
    setPermissions(group.permissions)
  }, [creating, group])

  const canEditMetadata = creating ? canEditRoleDetails : Boolean(group?.isEditable) && group?.canManage && canEditRoleDetails
  const canEditPermissions = creating
    ? canAssignRolePermissions
    : Boolean(group?.isEditable) && group?.canManage && canAssignRolePermissions
  const isEditable = canEditMetadata || canEditPermissions
  const normalizedName = name.trim()
  const normalizedDescription = description.trim() ? description.trim() : null
  const sortedPermissions = useMemo(
    () => [...permissions].sort((left, right) => (permissionOrder.get(left) ?? 0) - (permissionOrder.get(right) ?? 0)),
    [permissionOrder, permissions]
  )
  const hasChanges = creating
    ? normalizedName.length > 0 || normalizedDescription != null || sortedPermissions.length > 0
    : Boolean(
      group
      && (
        normalizedName !== group.name
        || normalizedDescription !== group.description
        || !samePermissions(sortedPermissions, group.permissions)
      )
    )

  const permissionLabelMap = useMemo(
    () => new Map(permissionDefinitions.map((definition) => [definition.key, definition.label])),
    [permissionDefinitions]
  )

  function togglePermission(permission: Permission, checked: boolean, sectionKeys: Permission[], anchorEl: PermissionPromptAnchor | null) {
    if (checked) {
      const missing = resolveMissingPrerequisites(permission, permissions)
      const crossSectionMissing = missing.filter((entry) => !sectionKeys.includes(entry))
      if (crossSectionMissing.length > 0) {
        setPrerequisitePrompt({ action: 'add', anchorEl, permission, affectedPermissions: missing })
        return
      }
      setPermissions((current) => addPermissions(current, [permission, ...missing]))
    } else {
      const dependentRemovals = resolveDependentRemovals(permission, permissions)
      if (dependentRemovals.length > 0) {
        setPrerequisitePrompt({ action: 'remove', anchorEl, permission, affectedPermissions: dependentRemovals })
        return
      }
      setPermissions((current) => current.filter((entry) => entry !== permission))
    }
  }

  function confirmPrerequisites() {
    if (!prerequisitePrompt) return
    const { action, permission, affectedPermissions } = prerequisitePrompt
    setPermissions((current) => {
      if (action === 'add') {
        return addPermissions(current, [permission, ...affectedPermissions])
      }
      const removals = new Set<Permission>([permission, ...affectedPermissions])
      return current.filter((entry) => !removals.has(entry))
    })
    setPrerequisitePrompt(null)
  }

  function handleSubmit() {
    if (!isEditable || normalizedName.length === 0) return
    if (creating) {
      onCreate({
        name: normalizedName,
        description: normalizedDescription,
        permissions: sortedPermissions
      })
      return
    }
    if (!group) return
    const body: UpdateAuthGroupRequest = {}
    if (canEditMetadata) {
      body.name = normalizedName
      body.description = normalizedDescription
    }
    if (canEditPermissions) {
      body.permissions = sortedPermissions
    }
    onUpdate(group.id, body)
  }

  return (
    <Modal open onClose={() => !saving && onClose()}>
      <>
        <ScrollableModalDialog sx={{ width: 'min(880px, 100%)' }}>
          <ModalClose disabled={saving} />
          <DialogTitle>
            {creating
              ? 'Create role'
              : isEditable
                ? `Edit role — ${group?.name ?? 'Role'}`
                : `Role permissions — ${group?.name ?? 'Role'}`}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={1}>
              <Typography level="body-sm" textColor="text.tertiary">
                Roles bundle reusable permissions so users and future service accounts can share the same access policy.
              </Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Chip size="sm" variant="soft" color="primary">
                  {sortedPermissions.length} of {permissionDefinitions.length} selected
                </Chip>
                {group?.isSystem && <Chip size="sm" variant="soft" color="primary">Built-in</Chip>}
                {!isEditable && <Chip size="sm" variant="soft" color="warning">Read-only</Chip>}
              </Stack>
              {!isEditable && (
                <Alert color="warning" variant="soft">
                  {group?.canManage === false
                    ? 'This role grants higher access than you can assign. You can review it here, but you cannot change it.'
                    : 'This built-in role is fixed. You can review its permissions here, but it cannot be edited or removed.'}
                </Alert>
              )}
            </Stack>
          </DialogContent>

          <ScrollableDialogBody>
            <Stack spacing={2}>
              <DialogSection title="Role details">
                <Stack spacing={1.25}>
                  <FormControl required>
                    <FormLabel>Role name</FormLabel>
                    <Input value={name} onChange={(event) => setName(event.target.value)} disabled={!canEditMetadata || saving} />
                  </FormControl>

                  <FormControl>
                    <FormLabel>Description</FormLabel>
                    <Textarea
                      minRows={3}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      disabled={!canEditMetadata || saving}
                      placeholder="Describe who should use this role and what it grants."
                    />
                  </FormControl>
                </Stack>
              </DialogSection>

              {error && (
                <Alert color="danger" variant="soft">
                  {error}
                </Alert>
              )}

              <DialogSection
                title="Permissions"
                description="Choose the access this role grants. Related permissions still follow the existing prerequisite rules."
                wrapInSheet={false}
              >
                <Stack spacing={1.5}>
                  {permissionSections.map((section) => {
                                      const isCollapsed = collapsedSections.has(section.title)
                    const selectedCount = section.permissions.filter((definition) => sortedPermissions.includes(definition.key)).length
                    const tree = buildPermissionTree(section.permissions)
                    const sectionKeys = section.permissions.map((definition) => definition.key)
                    return (
                      <Sheet key={section.title} variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                        <Stack spacing={1.25}>
                          <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" useFlexGap>
                            <Button
                              size="sm"
                              variant="plain"
                              color="neutral"
                              onClick={() => setCollapsedSections((current) => toggleCollapsedSection(current, section.title))}
                              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${section.title} permissions`}
                              startDecorator={isCollapsed ? <KeyboardArrowRightRoundedIcon /> : <KeyboardArrowDownRoundedIcon />}
                              sx={{ px: 0, justifyContent: 'flex-start', minWidth: 0 }}
                            >
                              <Box sx={{ minWidth: 0, textAlign: 'left' }}>
                                <Typography level="title-sm">{section.title}</Typography>
                                <Typography level="body-xs" textColor="text.tertiary">
                                  {selectedCount} of {section.permissions.length} granted
                                </Typography>
                              </Box>
                            </Button>
                            <Chip size="sm" variant="outlined" color="neutral">
                              {selectedCount}/{section.permissions.length}
                            </Chip>
                          </Stack>

                          {!isCollapsed && (
                            <Stack spacing={0.5}>
                              {tree.map((node) => (
                                <PermissionTreeNode
                                  key={node.definition.key}
                                  node={node}
                                  depth={0}
                                  selectedPermissions={sortedPermissions}
                                  disabled={!canEditPermissions || saving}
                                  assignablePermissionSet={assignablePermissionSet}
                                  permissionLabelMap={permissionLabelMap}
                                  sectionKeys={sectionKeys}
                                  onToggle={(permission, checked, anchorEl) => togglePermission(permission, checked, sectionKeys, anchorEl)}
                                />
                              ))}
                            </Stack>
                          )}
                        </Stack>
                      </Sheet>
                    )
                  })}
                </Stack>
              </DialogSection>
            </Stack>
          </ScrollableDialogBody>

          <DialogActions>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>
              {isEditable ? 'Cancel' : 'Close'}
            </Button>
            {isEditable && (
              <Button onClick={handleSubmit} loading={saving} disabled={normalizedName.length === 0 || !hasChanges}>
                {creating ? 'Create role' : 'Save changes'}
              </Button>
            )}
          </DialogActions>
        </ScrollableModalDialog>

        <PermissionDependencyPopover
          prompt={prerequisitePrompt}
          permissionLabelMap={permissionLabelMap}
          confirmLabel={prerequisitePrompt?.action === 'remove' ? 'Remove all' : 'Grant all'}
          onClose={() => setPrerequisitePrompt(null)}
          onConfirm={confirmPrerequisites}
        />
      </>
    </Modal>
  )
}

function DeleteAuthGroupDialog({
  group,
  error,
  deleting,
  onClose,
  onConfirm
}: {
  group: AuthGroup
  error: string | null
  deleting: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open onClose={() => !deleting && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(520px, 100%)' }}>
        <ModalClose disabled={deleting} />
        <DialogTitle>Delete role — {group.name}</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography level="body-sm" textColor="text.tertiary">
              This removes the role definition. Existing members of this role will lose the access it granted.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip size="sm" variant="soft" color="neutral">{formatCount(group.userCount, 'user')}</Chip>
              <Chip size="sm" variant="soft" color="neutral">{formatCount(group.serviceAccountCount, 'service account')}</Chip>
            </Stack>
            {error && (
              <Alert color="danger" variant="soft">
                {error}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button color="danger" onClick={onConfirm} loading={deleting}>
            Delete role
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function AuthUserManagementDialog({
  user,
  authProviders,
  groups,
  canDisableUserSignIn,
  canDeleteUsers,
  canAssignUserRoles,
  canViewRoles,
  canViewUserSessions,
  canRevokeUserSessions,
  canSendUserInvites,
  canViewUserPasskeys,
  canEditUserPasskeys,
  canRevokeUserPasskeys,
  isOnlyEnabledAdmin,
  sessions,
  sessionsLoading,
  sessionsError,
  accessError,
  lifecycleError,
  deleteError,
  savingAccess,
  mutatingLifecycle,
  revokingSessionId,
  onClose,
  onSubmit,
  onToggleLoginDisabled,
  onRevokeSession,
  onDeleteRequest
}: {
  user: AuthUser
  authProviders: AuthBootstrap['providers']
  groups: AuthGroup[]
  canDisableUserSignIn: boolean
  canDeleteUsers: boolean
  canAssignUserRoles: boolean
  canViewRoles: boolean
  canViewUserSessions: boolean
  canRevokeUserSessions: boolean
  canSendUserInvites: boolean
  canViewUserPasskeys: boolean
  canEditUserPasskeys: boolean
  canRevokeUserPasskeys: boolean
  isOnlyEnabledAdmin: boolean
  sessions: AuthSessionListResponse['sessions']
  sessionsLoading: boolean
  sessionsError: string | null
  accessError: string | null
  lifecycleError: string | null
  deleteError: string | null
  savingAccess: boolean
  mutatingLifecycle: boolean
  revokingSessionId: string | null
  onClose: () => void
  onSubmit: (groupIds: string[]) => void
  onToggleLoginDisabled: (loginDisabled: boolean) => void
  onRevokeSession: (sessionId: string) => void
  onDeleteRequest: () => void
}) {
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])

  useEffect(() => {
    setSelectedGroupIds(user.groups.map((group) => group.id))
  }, [user])

  const sortedSelectedGroupIds = useMemo(
    () => [...selectedGroupIds].sort(),
    [selectedGroupIds]
  )
  const originalGroupIds = useMemo(
    () => [...user.groups.map((group) => group.id)].sort(),
    [user.groups]
  )
  const hasAccessChanges = !sameIds(sortedSelectedGroupIds, originalGroupIds)
  const localAuthManaged = authProviders.some(
    (provider) => provider.id === 'auth-local' && provider.enabled && provider.capabilities.adminUserCredentials
  )
  const orderedGroups = useMemo(() => orderGroupsForDisplay(groups), [groups])
  const hasLifecyclePlugin = webPluginRegistry.slots('auth.userManagement.lifecycle').length > 0
  const canManageLifecycle = canDisableUserSignIn || canDeleteUsers || canSendUserInvites
  const canReviewOrAssignRoles = canViewRoles || canAssignUserRoles
  const canReviewSessions = canViewUserSessions
  const canManagePasskeys = canViewUserPasskeys || canEditUserPasskeys || canRevokeUserPasskeys

  const disableSignInAction = canDisableUserSignIn
    ? (
      <Button
        size="sm"
        variant="soft"
        color={user.loginDisabled ? 'success' : 'warning'}
        disabled={mutatingLifecycle || (isOnlyEnabledAdmin && !user.loginDisabled)}
        onClick={() => onToggleLoginDisabled(!user.loginDisabled)}
      >
        {user.loginDisabled ? 'Re-enable sign-in' : 'Disable sign-in'}
      </Button>
    )
    : null

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => {
      if (checked) {
        return current.includes(groupId) ? current : [...current, groupId]
      }
      return current.filter((entry) => entry !== groupId)
    })
  }

  return (
    <Modal open onClose={() => !savingAccess && !mutatingLifecycle && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(720px, 100%)' }}>
        <ModalClose disabled={savingAccess || mutatingLifecycle} />
        <DialogTitle>Manage user — {user.displayName?.trim() || user.email}</DialogTitle>
        <DialogContent>
          <Stack spacing={0.75}>
            <Typography level="body-sm" textColor="text.tertiary">
              Manage this user’s access policy, sign-in state, and provider-managed credentials.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip size="sm" variant="soft" color={user.loginDisabled ? 'warning' : 'success'}>
                {user.loginDisabled ? 'Sign-in disabled' : 'Sign-in enabled'}
              </Chip>
              <Chip size="sm" variant="soft" color="neutral">
                {sortedSelectedGroupIds.length} role{sortedSelectedGroupIds.length === 1 ? '' : 's'} selected
              </Chip>
              {localAuthManaged && (
                <Chip size="sm" variant="soft" color="neutral">
                  {user.passkeyCount} passkey{user.passkeyCount === 1 ? '' : 's'}
                </Chip>
              )}
            </Stack>
          </Stack>
        </DialogContent>

        <ScrollableDialogBody>
          <Stack spacing={2}>
            {accessError && (
              <Alert color="danger" variant="soft">
                {accessError}
              </Alert>
            )}

            {lifecycleError && (
              <Alert color="danger" variant="soft">
                {lifecycleError}
              </Alert>
            )}

            {deleteError && (
              <Alert color="danger" variant="soft">
                {deleteError}
              </Alert>
            )}

            {canManageLifecycle && (
              <DialogSection
                title="Account lifecycle"
                description="Disable sign-in temporarily or remove the account entirely. Providers can contribute setup and recovery actions below."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1.25}>
                    {isOnlyEnabledAdmin && (
                      <Alert color="warning" variant="soft">
                        This is the only enabled Admin user left. Keep at least one enabled Admin account to avoid locking the system out of auth management.
                      </Alert>
                    )}
                    <StaticPluginSlot
                      name="auth.userManagement.lifecycle"
                      context={{
                        user,
                        authProviders,
                        mutatingLifecycle,
                        canSendUserInvites,
                        extraActions: disableSignInAction
                      }}
                    />
                    {!hasLifecyclePlugin && (
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        {disableSignInAction}
                      </Stack>
                    )}
                  </Stack>
                </Sheet>
              </DialogSection>
            )}

            {canReviewOrAssignRoles && (groups.length === 0 ? (
              <Alert color="warning" variant="soft">
                Create at least one role before assigning user access.
              </Alert>
            ) : (
              <DialogSection
                title="Role assignments"
                description="Roles determine what this user can access across the app."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1}>
                    {orderedGroups.map((group) => (
                      <Checkbox
                        key={group.id}
                        checked={sortedSelectedGroupIds.includes(group.id)}
                        disabled={!canAssignUserRoles || savingAccess || !group.canManage || (isOnlyEnabledAdmin && group.key === 'admin' && sortedSelectedGroupIds.includes(group.id))}
                        onChange={(event) => toggleGroup(group.id, event.target.checked)}
                        label={(
                          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                              <Typography level="title-sm">{group.name}</Typography>
                              {group.isSystem && <Chip size="sm" variant="soft" color="primary">Built-in</Chip>}
                              {!group.canManage && <Chip size="sm" variant="soft" color="warning">Higher access</Chip>}
                            </Stack>
                            <Typography level="body-xs" textColor="text.tertiary">
                              {group.description?.trim() || 'No description yet.'}
                            </Typography>
                          </Stack>
                        )}
                        sx={{ alignItems: 'flex-start', '--Checkbox-gap': '0.75rem' }}
                      />
                    ))}
                  </Stack>
                </Sheet>
              </DialogSection>
            ))}

            {canManagePasskeys && (
              <StaticPluginSlot
                name="auth.userManagement.credentials"
                context={{
                  user,
                  authProviders,
                  mutatingLifecycle,
                  canViewUserPasskeys,
                  canEditUserPasskeys,
                  canRevokeUserPasskeys
                }}
              />
            )}

            {canReviewSessions && (
              <DialogSection
                title="Sessions"
                description="Review active browser sessions for this user and revoke any session that should no longer have access."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1}>
                    {sessionsError && (
                      <Alert color="danger" variant="soft">
                        {sessionsError}
                      </Alert>
                    )}

                    {sessionsLoading ? (
                      <Typography level="body-sm" textColor="text.tertiary">
                        Loading sessions…
                      </Typography>
                    ) : (
                      <AuthSessionList
                        sessions={sessions}
                        emptyMessage="No active sessions found for this user."
                        revokingSessionId={revokingSessionId}
                        onRevoke={canRevokeUserSessions ? onRevokeSession : undefined}
                        actionsDisabled={mutatingLifecycle || !canRevokeUserSessions}
                        cardVariant="outlined"
                      />
                    )}
                  </Stack>
                </Sheet>
              </DialogSection>
            )}
          </Stack>
        </ScrollableDialogBody>

        <DialogActions sx={{ justifyContent: 'space-between' }}>
          {canDeleteUsers ? (
            <Button
              variant="plain"
              color="danger"
              onClick={onDeleteRequest}
              disabled={mutatingLifecycle || savingAccess || isOnlyEnabledAdmin}
            >
              Delete user
            </Button>
          ) : <span />}
          <Stack direction="row" spacing={1}>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={savingAccess || mutatingLifecycle}>
              Cancel
            </Button>
            {canAssignUserRoles && (
              <Button onClick={() => onSubmit(sortedSelectedGroupIds)} loading={savingAccess} disabled={!hasAccessChanges || mutatingLifecycle}>
                Save access
              </Button>
            )}
          </Stack>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

function DeleteAuthUserDialog({
  user,
  error,
  deleting,
  onClose,
  onConfirm
}: {
  user: AuthUser
  error: string | null
  deleting: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open onClose={() => !deleting && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(520px, 100%)' }}>
        <ModalClose disabled={deleting} />
        <DialogTitle>Delete user — {user.displayName?.trim() || user.email}</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography level="body-sm" textColor="text.tertiary">
              This removes the user account, its sessions, any pending email codes, and all registered passkeys.
            </Typography>
            {error && (
              <Alert color="danger" variant="soft">
                {error}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button color="danger" onClick={onConfirm} loading={deleting}>
            Delete user
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

function AuthServiceAccountEditorDialog({
  serviceAccount,
  groups,
  creating,
  canEditServiceAccountName,
  canAssignServiceAccountRoles,
  error,
  saving,
  onClose,
  onCreate,
  onUpdate
}: {
  serviceAccount: AuthServiceAccount | null
  groups: AuthGroup[]
  creating: boolean
  canEditServiceAccountName: boolean
  canAssignServiceAccountRoles: boolean
  error: string | null
  saving: boolean
  onClose: () => void
  onCreate: (body: CreateAuthServiceAccountRequest) => void
  onUpdate: (serviceAccountId: string, body: UpdateAuthServiceAccountRequest) => void
}) {
  const [name, setName] = useState('')
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])

  useEffect(() => {
    if (creating) {
      setName('')
      setSelectedGroupIds([])
      return
    }

    if (!serviceAccount) return
    setName(serviceAccount.name)
    setSelectedGroupIds(serviceAccount.groups.map((group) => group.id))
  }, [creating, serviceAccount])

  const normalizedName = name.trim()
  const sortedSelectedGroupIds = useMemo(
    () => [...selectedGroupIds].sort(),
    [selectedGroupIds]
  )
  const orderedGroups = useMemo(() => orderGroupsForDisplay(groups), [groups])
  const originalGroupIds = useMemo(
    () => [...(serviceAccount?.groups.map((group) => group.id) ?? [])].sort(),
    [serviceAccount?.groups]
  )
  const canEditName = creating ? canEditServiceAccountName : canEditServiceAccountName && Boolean(serviceAccount?.canManage)
  const canAssignRoles = creating ? canAssignServiceAccountRoles : canAssignServiceAccountRoles && Boolean(serviceAccount?.canManage)
  const isEditable = canEditName || canAssignRoles
  const hasChanges = creating
    ? normalizedName.length > 0 || sortedSelectedGroupIds.length > 0
    : Boolean(
      serviceAccount
      && (
        normalizedName !== serviceAccount.name
        || !sameIds(sortedSelectedGroupIds, originalGroupIds)
      )
    )

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => {
      if (checked) {
        return current.includes(groupId) ? current : [...current, groupId]
      }
      return current.filter((entry) => entry !== groupId)
    })
  }

  function handleSubmit() {
    if (!isEditable || normalizedName.length === 0) return
    if (creating) {
      onCreate({
        name: normalizedName,
        groupIds: sortedSelectedGroupIds
      })
      return
    }
    if (!serviceAccount) return
    onUpdate(serviceAccount.id, {
      ...(canEditName ? { name: normalizedName } : {}),
      ...(canAssignRoles ? { groupIds: sortedSelectedGroupIds } : {})
    })
  }

  return (
    <Modal open onClose={() => !saving && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(720px, 100%)' }}>
        <ModalClose disabled={saving} />
        <DialogTitle>
          {creating
            ? 'Create service account'
            : `Edit service account — ${serviceAccount?.name ?? 'Service account'}`}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={0.75}>
            <Typography level="body-sm" textColor="text.tertiary">
              Service accounts provide role-based access for automation and external integrations.
            </Typography>
            {!creating && serviceAccount?.canManage === false && (
              <Alert color="warning" variant="soft">
                This service account has higher access than you can manage. You can review it here, but you cannot change it.
              </Alert>
            )}
            {serviceAccount?.revokedAt && (
              <Alert color="warning" variant="soft">
                This service account is revoked. You can still review or adjust its role assignments here.
              </Alert>
            )}
          </Stack>
        </DialogContent>

        <ScrollableDialogBody>
          <Stack spacing={2}>
            <DialogSection title="Service account details">
              <FormControl required>
                <FormLabel>Name</FormLabel>
                <Input value={name} onChange={(event) => setName(event.target.value)} disabled={!canEditName || saving} placeholder="CI deploy worker" />
              </FormControl>
            </DialogSection>

            {error && (
              <Alert color="danger" variant="soft">
                {error}
              </Alert>
            )}

            {groups.length === 0 ? (
              <Alert color="warning" variant="soft">
                Create at least one role before creating a service account.
              </Alert>
            ) : (
              <DialogSection
                title="Role assignments"
                description="Choose the roles this service account should have in this workspace."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1}>
                    {orderedGroups.map((group) => (
                      <Checkbox
                        key={group.id}
                        checked={sortedSelectedGroupIds.includes(group.id)}
                        disabled={!canAssignRoles || saving || !group.canManage}
                        onChange={(event) => toggleGroup(group.id, event.target.checked)}
                        label={(
                          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                              <Typography level="title-sm">{group.name}</Typography>
                              {group.isSystem && <Chip size="sm" variant="soft" color="primary">Built-in</Chip>}
                              {!group.canManage && <Chip size="sm" variant="soft" color="warning">Higher access</Chip>}
                            </Stack>
                            <Typography level="body-xs" textColor="text.tertiary">
                              {group.description?.trim() || 'No description yet.'}
                            </Typography>
                          </Stack>
                        )}
                        sx={{ alignItems: 'flex-start', '--Checkbox-gap': '0.75rem' }}
                      />
                    ))}
                  </Stack>
                </Sheet>
              </DialogSection>
            )}
          </Stack>
        </ScrollableDialogBody>

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>
            {isEditable ? 'Cancel' : 'Close'}
          </Button>
          {isEditable && (
            <Button onClick={handleSubmit} loading={saving} disabled={normalizedName.length === 0 || !hasChanges}>
              {creating ? 'Create service account' : 'Save changes'}
            </Button>
          )}
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

function CreatedServiceAccountTokenDialog({
  revealedToken,
  onClose
}: {
  revealedToken: RevealedServiceAccountToken
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(revealedToken.token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: 'min(680px, 100%)' }}>
        <ModalClose />
        <DialogTitle>Service account token</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography level="body-sm" textColor="text.tertiary">
              Save this token now. It is only shown once after the service account is created.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip size="sm" variant="soft" color="primary">{revealedToken.name}</Chip>
              <Chip size="sm" variant="soft" color="neutral">{revealedToken.tokenPrefix}</Chip>
            </Stack>
          </Stack>
        </DialogContent>

        <ScrollableDialogBody>
          <Stack spacing={1.5}>
            <FormControl>
              <FormLabel>Token</FormLabel>
              <Textarea minRows={3} value={revealedToken.token} readOnly />
            </FormControl>
            {copied && (
              <Alert color="success" variant="soft">
                Token copied to the clipboard.
              </Alert>
            )}
          </Stack>
        </ScrollableDialogBody>

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void handleCopy()}>
            Copy token
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

function AuthManagementOverviewCards({
  userCount,
  roleCount,
  permissionCount,
  onOpenUsers,
  onOpenRoles
}: {
  userCount: number
  roleCount: number
  permissionCount: number
  onOpenUsers?: () => void
  onOpenRoles?: () => void
}) {
  return (
    <Stack spacing={1.25}>
      <Box>
        <Typography level="title-md">Access management</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Open a dedicated users or roles view when you need to manage auth access in detail.
        </Typography>
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
        <Card variant="outlined" sx={{ flex: 1 }}>
          <CardContent>
            <Stack spacing={1.25}>
              <Box>
                <Typography level="title-sm">Users</Typography>
              </Box>
              <Chip size="sm" variant="soft" color="neutral" sx={{ alignSelf: 'flex-start' }}>
                {userCount} user{userCount === 1 ? '' : 's'}
              </Chip>
              <Button size="sm" variant="soft" color="primary" onClick={onOpenUsers} disabled={!onOpenUsers}>
                Open users
              </Button>
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined" sx={{ flex: 1 }}>
          <CardContent>
            <Stack spacing={1.25}>
              <Box>
                <Typography level="title-sm">Roles</Typography>
              </Box>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Chip size="sm" variant="soft" color="primary">
                  {roleCount} role{roleCount === 1 ? '' : 's'}
                </Chip>
                <Chip size="sm" variant="soft" color="neutral">
                  {permissionCount} permission{permissionCount === 1 ? '' : 's'}
                </Chip>
              </Stack>
              <Button size="sm" variant="soft" color="primary" onClick={onOpenRoles} disabled={!onOpenRoles}>
                Open roles
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    </Stack>
  )
}

function RolePermissionsMatrix({
  groups,
  permissionSections,
  permissionLabelByKey,
  canDeleteRoles,
  onOpenRole,
  onDeleteRole
}: {
  groups: AuthGroup[]
  permissionSections: PermissionSection[]
  permissionLabelByKey: Map<Permission, string>
  canDeleteRoles: boolean
  onOpenRole: (groupId: string) => void
  onDeleteRole: (group: AuthGroup) => void
}) {
  const [showBuiltInRoles, setShowBuiltInRoles] = useState(true)
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())
  const permissionColumnMinWidth = 176
  const roleColumnWidth = 132
  const orderedGroups = useMemo(() => orderGroupsForDisplay(groups), [groups])
  const visibleGroups = useMemo(
    () => showBuiltInRoles ? orderedGroups : orderedGroups.filter((group) => !group.isSystem),
    [orderedGroups, showBuiltInRoles]
  )
  const permissionRowsBySection = useMemo<PermissionSectionRows[]>(
    () => permissionSections.map((section) => ({
      title: section.title,
      rows: flattenPermissionTree(buildPermissionTree(section.permissions))
    })),
    [permissionSections]
  )
  const permissionSetByGroup = new Map(visibleGroups.map((group) => [group.id, new Set(group.permissions)] as const))

  if (visibleGroups.length === 0) {
    return (
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="flex-end">
          <Button size="sm" variant="soft" color="neutral" onClick={() => setShowBuiltInRoles(true)}>
            Show built-in roles
          </Button>
        </Stack>
        <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2 }}>
          <Typography level="body-sm" textColor="text.tertiary">
            Built-in roles are hidden. Show them again to compare their permissions.
          </Typography>
        </Sheet>
      </Stack>
    )
  }

  return (
    <Stack spacing={1}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
      >
        <Typography level="body-xs" textColor="text.tertiary">
          Built-in roles stay grouped first. Custom roles follow after them.
        </Typography>
        <Button
          size="sm"
          variant="soft"
          color="neutral"
          onClick={() => setShowBuiltInRoles((current) => !current)}
        >
          {showBuiltInRoles ? 'Hide built-in roles' : 'Show built-in roles'}
        </Button>
      </Stack>

      <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
        <Box>
          <HorizontalOverflowScroller fadeColor="var(--joy-palette-background-surface)" hideScrollbar={false}>
            <Table
              stickyHeader
              borderAxis="bothBetween"
              sx={{
                '--TableCell-headBackground': 'var(--joy-palette-background-level1)',
                minWidth: `${permissionColumnMinWidth + (visibleGroups.length * roleColumnWidth)}px`,
                '& tbody th[scope="row"]': {
                  whiteSpace: 'normal',
                  textOverflow: 'clip',
                  overflow: 'visible',
                  height: 'auto',
                  verticalAlign: 'top'
                }
              }}
            >
            <thead>
              <tr>
                <th style={{ minWidth: `${permissionColumnMinWidth}px` }}>Permission</th>
                {visibleGroups.map((group) => (
                  <th key={group.id} style={{ width: `${roleColumnWidth}px`, verticalAlign: 'top' }}>
                    <Stack spacing={0.75} sx={{ py: 0.5 }}>
                      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                        <Typography level="title-sm" sx={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>
                          {group.name}
                        </Typography>
                        <Tooltip
                          arrow
                          placement="top"
                          title={(
                            <Stack spacing={0.5} sx={{ py: 0.25, maxWidth: 240 }}>
                              <Typography level="title-sm">{group.name}</Typography>
                              <Typography level="body-xs">
                                {group.description?.trim() || 'No description yet.'}
                              </Typography>
                              <Typography level="body-xs" textColor="text.tertiary">
                                {summarizeRoleFlags(group)}
                              </Typography>
                            </Stack>
                          )}
                        >
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="neutral"
                            aria-label={`About ${group.name} role`}
                            sx={{ flexShrink: 0 }}
                          >
                            <InfoOutlinedIcon />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        <Chip size="sm" variant="soft" color="neutral">
                          {group.permissions.length} perm{group.permissions.length === 1 ? '' : 's'}
                        </Chip>
                        <Chip size="sm" variant="soft" color="neutral">
                          {group.userCount} user{group.userCount === 1 ? '' : 's'}
                        </Chip>
                      </Stack>
                      <Stack direction="row" spacing={0.25} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        <Tooltip title={group.isEditable ? `Edit ${group.name}` : `View ${group.name}`} arrow placement="top">
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="neutral"
                            aria-label={group.isEditable && group.canManage ? `Edit ${group.name}` : `View ${group.name}`}
                            onClick={() => onOpenRole(group.id)}
                          >
                            {group.isEditable && group.canManage ? <EditRoundedIcon /> : <VisibilityRoundedIcon />}
                          </IconButton>
                        </Tooltip>
                        {group.isRemovable && canDeleteRoles && group.canManage && (
                          <Tooltip title={`Delete ${group.name}`} arrow placement="top">
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="danger"
                              aria-label={`Delete ${group.name}`}
                              onClick={() => onDeleteRole(group)}
                            >
                              <DeleteRoundedIcon />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Stack>
                    </Stack>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissionRowsBySection.map((section) => (
                <React.Fragment key={section.title}>
                  <tr>
                    <th colSpan={visibleGroups.length + 1} style={{ background: 'var(--joy-palette-background-level1)' }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} useFlexGap>
                        <Button
                          size="sm"
                          variant="plain"
                          color="neutral"
                          onClick={() => setCollapsedSections((current) => toggleCollapsedSection(current, section.title))}
                          aria-label={`${collapsedSections.has(section.title) ? 'Expand' : 'Collapse'} ${section.title} group`}
                          startDecorator={collapsedSections.has(section.title) ? <KeyboardArrowRightRoundedIcon /> : <KeyboardArrowDownRoundedIcon />}
                          sx={{ px: 0, justifyContent: 'flex-start' }}
                        >
                          {section.title}
                        </Button>
                        <Chip size="sm" variant="soft" color="neutral">
                          {section.rows.length}
                        </Chip>
                      </Stack>
                    </th>
                  </tr>
                  {!collapsedSections.has(section.title) && section.rows.map(({ definition, depth }) => (
                    <tr key={definition.key}>
                      <th scope="row" style={{ minWidth: `${permissionColumnMinWidth}px` }}>
                        <Stack
                          direction="row"
                          spacing={0.5}
                          alignItems="center"
                          data-depth={depth + 1}
                          sx={{ py: 0.25, minWidth: 0, pl: (depth + 1) * 2 }}
                        >
                          <Typography level="body-sm" sx={{ minWidth: 0, flex: 1, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                            {permissionLabelByKey.get(definition.key) ?? definition.label}
                          </Typography>
                          <Tooltip
                            arrow
                            placement="top-start"
                            title={(
                              <Stack spacing={0.5} sx={{ py: 0.25, maxWidth: 240 }}>
                                <Typography level="title-sm">{permissionLabelByKey.get(definition.key) ?? definition.label}</Typography>
                                <Typography level="body-xs">
                                  {definition.description}
                                </Typography>
                              </Stack>
                            )}
                          >
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="neutral"
                              aria-label={`About ${permissionLabelByKey.get(definition.key) ?? definition.label} permission`}
                              sx={{ flexShrink: 0 }}
                            >
                              <InfoOutlinedIcon />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </th>
                      {visibleGroups.map((group) => {
                        const granted = permissionSetByGroup.get(group.id)?.has(definition.key) ?? false
                        return (
                          <td key={`${group.id}:${definition.key}`}>
                            <Chip size="sm" variant={granted ? 'soft' : 'outlined'} color={granted ? 'success' : 'neutral'}>
                              {granted ? 'Yes' : '--'}
                            </Chip>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
            </Table>
          </HorizontalOverflowScroller>
        </Box>
      </Sheet>
    </Stack>
  )
}

function summarizeRoleFlags(group: AuthGroup): string {
  const flags = []
  if (group.isSystem) flags.push('Built-in')
  if (!group.isEditable) flags.push('Read-only')
  if (!group.isRemovable) flags.push('Protected')
  return flags.length > 0 ? flags.join(' · ') : 'Custom role'
}

function toggleCollapsedSection(current: ReadonlySet<string>, title: string): Set<string> {
  const next = new Set(current)
  if (next.has(title)) {
    next.delete(title)
  } else {
    next.add(title)
  }
  return next
}

function orderGroupsForDisplay(groups: AuthGroup[]): AuthGroup[] {
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

interface PermissionTreeNodeData {
  definition: PermissionDefinition
  children: PermissionTreeNodeData[]
}

interface FlattenedPermissionTreeRow {
  definition: PermissionDefinition
  depth: number
}

type PermissionPromptAnchor = HTMLElement

interface PermissionPrerequisitePrompt {
  action: 'add' | 'remove'
  anchorEl: PermissionPromptAnchor | null
  permission: Permission
  affectedPermissions: Permission[]
}

/**
 * Builds a tree of permissions within a section. A permission is a child if its
 * only same-section prerequisite is a single permission (its parent). Permissions
 * with multiple same-section prerequisites or no same-section prerequisites are roots.
 */
function buildPermissionTree(definitions: PermissionDefinition[]): PermissionTreeNodeData[] {
  const sectionKeys = new Set(definitions.map((d) => d.key))
  const childToParent = new Map<Permission, Permission>()

  for (const definition of definitions) {
    const prereqs = getPermissionPrerequisites(definition.key)
    const sameSectionPrereqs = prereqs.filter((p) => sectionKeys.has(p))
    // Only nest if there's exactly one same-section parent
    if (sameSectionPrereqs.length === 1) {
      childToParent.set(definition.key, sameSectionPrereqs[0]!)
    }
  }

  // First pass: create all nodes
  const nodeMap = new Map<Permission, PermissionTreeNodeData>()
  for (const definition of definitions) {
    nodeMap.set(definition.key, { definition, children: [] })
  }

  // Second pass: assign children to parents
  const roots: PermissionTreeNodeData[] = []
  for (const definition of definitions) {
    const node = nodeMap.get(definition.key)!
    const parent = childToParent.get(definition.key)
    if (parent) {
      nodeMap.get(parent)?.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

function flattenPermissionTree(nodes: PermissionTreeNodeData[], depth = 0): FlattenedPermissionTreeRow[] {
  return nodes.flatMap((node) => [
    { definition: node.definition, depth },
    ...flattenPermissionTree(node.children, depth + 1)
  ])
}

function PermissionTreeNode({
  node,
  depth,
  selectedPermissions,
  disabled,
  assignablePermissionSet,
  permissionLabelMap,
  sectionKeys,
  onToggle
}: {
  node: PermissionTreeNodeData
  depth: number
  selectedPermissions: Permission[]
  disabled: boolean
  assignablePermissionSet: ReadonlySet<Permission>
  permissionLabelMap: Map<Permission, string>
  sectionKeys: Permission[]
  onToggle: (permission: Permission, checked: boolean, anchorEl: PermissionPromptAnchor | null) => void
}) {
  const { definition } = node
  const prerequisites = getPermissionPrerequisites(definition.key)
  const crossSectionPrereqs = prerequisites.filter((p) => !sectionKeys.includes(p))

  return (
    <Stack spacing={0.5} sx={depth > 0 ? { pl: 3 } : undefined}>
      <Checkbox
        size="sm"
        checked={selectedPermissions.includes(definition.key)}
        disabled={disabled || !assignablePermissionSet.has(definition.key)}
        onChange={(event) => onToggle(definition.key, event.target.checked, resolvePermissionAnchor(event.currentTarget))}
        label={(
          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography level="title-sm">{definition.label}</Typography>
              {!assignablePermissionSet.has(definition.key) && (
                <Chip size="sm" variant="soft" color="warning">Higher access</Chip>
              )}
              {crossSectionPrereqs.map((prereq) => (
                <Chip key={prereq} size="sm" variant="soft" color="neutral">
                  Requires {permissionLabelMap.get(prereq) ?? prereq}
                </Chip>
              ))}
            </Stack>
            <Typography level="body-xs" textColor="text.tertiary">
              {definition.description}
            </Typography>
          </Stack>
        )}
        sx={{ alignItems: 'flex-start', '--Checkbox-gap': '0.75rem' }}
      />
      {node.children.map((child) => (
        <PermissionTreeNode
          key={child.definition.key}
          node={child}
          depth={depth + 1}
          selectedPermissions={selectedPermissions}
          disabled={disabled}
          assignablePermissionSet={assignablePermissionSet}
          permissionLabelMap={permissionLabelMap}
          sectionKeys={sectionKeys}
          onToggle={onToggle}
        />
      ))}
    </Stack>
  )
}

function resolveMissingPrerequisites(permission: Permission, selectedPermissions: readonly Permission[]): Permission[] {
  return resolveImpliedPermissions([permission]).filter((entry) => !selectedPermissions.includes(entry))
}

function resolvePermissionAnchor(input: EventTarget & HTMLInputElement): PermissionPromptAnchor {
  if (input.parentElement?.parentElement instanceof HTMLElement) {
    return input.parentElement.parentElement
  }
  if (input.parentElement instanceof HTMLElement) {
    return input.parentElement
  }
  return input
}

function resolveDependentRemovals(permission: Permission, selectedPermissions: readonly Permission[]): Permission[] {
  const remaining = new Set(selectedPermissions.filter((entry) => entry !== permission))
  const removed = new Set<Permission>()
  let changed = true

  while (changed) {
    changed = false
    for (const candidate of [...remaining]) {
      const prerequisites = getPermissionPrerequisites(candidate)
      if (prerequisites.some((entry) => !remaining.has(entry))) {
        remaining.delete(candidate)
        removed.add(candidate)
        changed = true
      }
    }
  }

  return selectedPermissions.filter((entry) => removed.has(entry))
}

function addPermissions(current: readonly Permission[], additions: readonly Permission[]): Permission[] {
  const next = new Set(current)
  for (const permission of additions) {
    next.add(permission)
  }
  return [...next]
}

function PermissionDependencyPopover({
  prompt,
  permissionLabelMap,
  confirmLabel,
  onClose,
  onConfirm
}: {
  prompt: PermissionPrerequisitePrompt | null
  permissionLabelMap: Map<Permission, string>
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}) {
  const [arrowEl, setArrowEl] = useState<HTMLSpanElement | null>(null)

  if (!prompt) return null

  return (
    <Popper
      open
      anchorEl={prompt.anchorEl}
      placement="right"
      modifiers={[
        {
          name: 'offset',
          options: { offset: [0, 10] }
        },
        {
          name: 'arrow',
          options: { element: arrowEl }
        },
        {
          name: 'flip',
          options: { padding: 8 }
        },
        {
          name: 'preventOverflow',
          options: { padding: 8 }
        }
      ]}
      style={{ zIndex: 1600 }}
    >
      <Box sx={{ position: 'relative' }}>
        <Box
          ref={setArrowEl}
          sx={{
            position: 'absolute',
            width: 12,
            height: 12,
            bgcolor: 'background.surface',
            borderTop: '1px solid',
            borderLeft: '1px solid',
            borderColor: 'divider',
            transform: 'rotate(45deg)',
            zIndex: 0,
            '[data-popper-placement*="right"] &': {
              left: -6,
              top: 'calc(50% - 6px)'
            },
            '[data-popper-placement*="left"] &': {
              right: -6,
              top: 'calc(50% - 6px)',
              transform: 'rotate(225deg)'
            },
            '[data-popper-placement*="top"] &': {
              bottom: -6,
              left: 'calc(50% - 6px)',
              transform: 'rotate(135deg)'
            },
            '[data-popper-placement*="bottom"] &': {
              top: -6,
              left: 'calc(50% - 6px)',
              transform: 'rotate(-45deg)'
            }
          }}
        />
        <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'md', boxShadow: 'lg', maxWidth: 320, position: 'relative', zIndex: 1 }}>
          <Stack spacing={1}>
            <Typography level="title-sm">
              {prompt.action === 'add' ? 'Grant required permissions?' : 'Remove dependent permissions?'}
            </Typography>
            <Typography level="body-sm">
              {permissionLabelMap.get(prompt.permission) ?? prompt.permission}
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              {prompt.action === 'add'
                ? 'This selection also requires permissions in other sections.'
                : 'Removing this permission also removes dependent permissions that no longer have their required parents.'}
            </Typography>
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {prompt.affectedPermissions.map((permission) => (
                <Chip key={permission} size="sm" variant="soft" color="primary">
                  {permissionLabelMap.get(permission) ?? permission}
                </Chip>
              ))}
            </Stack>
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button size="sm" variant="plain" color="neutral" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={onConfirm}>{confirmLabel}</Button>
            </Stack>
          </Stack>
        </Sheet>
      </Box>
    </Popper>
  )
}

function buildPermissionSections(definitions: PermissionDefinition[]): PermissionSection[] {
  const order = [
    'Platform',
    'Authentication',
    'Printers & Devices',
    'Library',
    'Jobs',
    'Plugins',
    'Settings',
    'Other'
  ] as const
  const grouped = new Map<string, PermissionDefinition[]>()

  for (const definition of definitions) {
    const title = permissionSectionTitle(definition.key)
    const existing = grouped.get(title)
    if (existing) {
      existing.push(definition)
      continue
    }
    grouped.set(title, [definition])
  }

  return order.flatMap((title) => {
    const permissions = grouped.get(title)
    return permissions ? [{ title, permissions }] : []
  })
}

function permissionSectionTitle(permission: Permission): string {
  if (permission === 'tenants.manage' || permission === 'tenants.disable') return 'Platform'
  if (permission.startsWith('auth.')) return 'Authentication'
  if (
    permission.startsWith('camera.')
    || permission.startsWith('printerStorage.')
    || permission.startsWith('printers.')
    || permission.startsWith('prints.dispatch')
  ) {
    return 'Printers & Devices'
  }
  if (permission.startsWith('library.')) return 'Library'
  if (permission.startsWith('jobs.')) return 'Jobs'
  if (permission.startsWith('plugins.')) return 'Plugins'
  if (permission.startsWith('settings.')) return 'Settings'
  return 'Other'
}

function samePermissions(left: Permission[], right: Permission[]): boolean {
  if (left.length !== right.length) return false
  return left.every((permission, index) => permission === right[index])
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}