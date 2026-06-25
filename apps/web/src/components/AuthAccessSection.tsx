/**
 * Settings subsection for authentication access management: roles (groups) and
 * their permissions, users, service accounts, browser session-duration policy,
 * and support-access controls. Each surface is gated by the capabilities the
 * server reports in `AuthManagementStatus`, and `mode` selects which surfaces
 * render (full settings vs. the standalone Users / Roles / overview screens).
 */
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControl,
  FormLabel,
  Input,
  Option,
  Select,
  Stack,
  Typography
} from '@mui/joy'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
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
  type UpdateAuthUserRequest,
  type UpdateAuthServiceAccountRequest,
  type UpdateAuthUserGroupsRequest,
  type UpdateAuthGroupRequest
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../lib/apiClient'
import {
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
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { type DirectoryViewMode } from './DirectoryControls'
import { DirectoryPrimaryToolbar } from './DirectoryToolbar'
import { MultiSelectOption } from './MultiSelectOption'
import { useMobileViewport } from './useMobileViewport'
import { SectionNav } from './dashboard/SectionNav'
import { sectionScrollMarginTop } from './dashboard/SectionNav.constants'
import { ProviderRecentVerificationDialog } from './ProviderRecentVerificationDialog'
import { PaginatedSection } from './PaginationFooter'
import {
  CUSTOM_SESSION_DURATION_OPTION,
  formatDateTime,
  formatSessionDurationDetail,
  formatSessionDurationLabel,
  formatSessionDurationSelectLabel,
  parseCustomSessionDurationMinutes,
  parseUserDirectoryViewMode,
  readAuthAlertDecorator,
  type RevealedServiceAccountToken,
  samePermissions,
  SESSION_DURATION_OPTIONS,
  type SessionDurationSelectValue,
  shouldAutoOpenCreatedUserEditor,
  USER_DIRECTORY_VIEW_MODE_KEY,
  USER_PAGE_SIZE_OPTIONS
} from './authAccessHelpers'
import { buildPermissionSections, RolePermissionsMatrix } from './permissionMatrix'
import {
  AuthGroupEditorDialog,
  AuthManagementOverviewCards,
  AuthServiceAccountEditorDialog,
  AuthUserManagementDialog,
  CreateAuthUserDialog,
  CreatedServiceAccountTokenDialog,
  DeleteAuthGroupDialog,
  DeleteAuthUserDialog,
  SupportAccessPermissionsDialog
} from './authAccessDialogs'

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

type EditorState =
  | { mode: 'create' }
  | { mode: 'group'; groupId: string }

type ServiceAccountEditorState =
  | { mode: 'create' }
  | { mode: 'service-account'; serviceAccountId: string }

type PendingSensitiveAction =
  | { type: 'update-support-access'; body: Partial<Pick<GeneralSettings, 'supportAccessEnabled' | 'supportAccessPermissions'>> }
  | { type: 'create-group'; body: CreateAuthGroupRequest }
  | { type: 'update-group'; groupId: string; body: UpdateAuthGroupRequest }
  | { type: 'create-user'; body: CreateManagedAuthUserRequest }
  | { type: 'update-user-groups'; userId: string; body: UpdateAuthUserGroupsRequest }
  | { type: 'create-service-account'; body: CreateAuthServiceAccountRequest }
  | { type: 'update-service-account'; serviceAccountId: string; body: UpdateAuthServiceAccountRequest }

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
  // Support access (platform/support users entering a workspace) is a cloud-only
  // concept; self-hosted (OSS) is single-workspace with no such users.
  const { selfHosted } = useRuntimePolicy()
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
  const [userRoleFilters, setUserRoleFilters] = useState<string[]>([])
  const [userSortKey, setUserSortKey] = useState<UserSortKey>('name')
  const [userSortDirection, setUserSortDirection] = useState<UserSortDirection>('asc')
  const [userPage, setUserPage] = useState(1)
  const [userPageSize, setUserPageSize] = useState<number>(USER_PAGE_SIZE_OPTIONS[1])
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
  const showSupportControls = hasEnabledAuthProvider && (mode === 'full' || mode === 'overview') && hasTenantScopedSettings && !selfHosted
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
      roleFilters: userRoleFilters,
      sortKey: userSortKey,
      sortDirection: userSortDirection
    }),
    [normalizedUserSearch, userRoleFilters, userSortDirection, userSortKey, userStatusFilter, users]
  )
  const hasActiveUserFilters = userStatusFilter !== 'all'
    || userRoleFilters.length > 0
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
    // Drop any selected role that no longer exists; keep the "unassigned" sentinel.
    const valid = new Set([UNASSIGNED_USER_ROLE_FILTER, ...availableUserRoleOptions.map((option) => option.value)])
    setUserRoleFilters((current) => {
      const next = current.filter((value) => valid.has(value))
      return next.length === current.length ? current : next
    })
  }, [availableUserRoleOptions])
  useEffect(() => {
    setUserPage(1)
  }, [normalizedUserSearch, userRoleFilters, userSortDirection, userSortKey, userStatusFilter, userPageSize])
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
    setUserRoleFilters([])
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
                        filters={{
                          activeCount: Number(userStatusFilter !== 'all') + Number(userRoleFilters.length > 0),
                          onClear: clearUserFilters,
                          clearDisabled: !hasActiveUserFilters,
                          children: (
                            <>
                              <FormControl>
                                <FormLabel>Status</FormLabel>
                                <Select<UserStatusFilter>
                                  size="sm"
                                  value={userStatusFilter}
                                  onChange={(_event, value) => value && setUserStatusFilter(value)}
                                  slotProps={{ listbox: { disablePortal: true } }}
                                >
                                  {USER_STATUS_OPTIONS.map((option) => (
                                    <Option key={option.value} value={option.value}>{option.label}</Option>
                                  ))}
                                </Select>
                              </FormControl>
                              <FormControl>
                                <FormLabel>Role</FormLabel>
                                <Select
                                  multiple
                                  size="sm"
                                  value={userRoleFilters}
                                  onChange={(_event, value) => setUserRoleFilters(value ?? [])}
                                  placeholder="All roles"
                                  renderValue={() => userRoleFilters.length === 0 ? null : userRoleFilters
                                    .map((value) => value === UNASSIGNED_USER_ROLE_FILTER
                                      ? 'No roles assigned'
                                      : (availableUserRoleOptions.find((option) => option.value === value)?.label ?? value))
                                    .join(', ')}
                                  slotProps={{ listbox: { disablePortal: true } }}
                                >
                                  <MultiSelectOption value={UNASSIGNED_USER_ROLE_FILTER} selected={userRoleFilters.includes(UNASSIGNED_USER_ROLE_FILTER)}>No roles assigned</MultiSelectOption>
                                  {availableUserRoleOptions.map((option) => (
                                    <MultiSelectOption key={option.value} value={option.value} selected={userRoleFilters.includes(option.value)}>{option.label}</MultiSelectOption>
                                  ))}
                                </Select>
                              </FormControl>
                            </>
                          )
                        }}
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
                        disableIconModeOnMobile                      />
                    </Stack>

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
          canEditUsers={canEditUsers}
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

export { AuthUserManagementDialog } from './authAccessDialogs'
// eslint-disable-next-line react-refresh/only-export-components -- re-exported for the existing import surface and focused unit coverage.
export { shouldAutoOpenCreatedUserEditor } from './authAccessHelpers'
