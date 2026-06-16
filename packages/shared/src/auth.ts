/**
 * Auth contracts shared by the API and web client: the bootstrap snapshot,
 * sign-in flows (passkeys, email codes, OAuth providers), session policy, and
 * the management surface for users, groups/roles, and service accounts.
 */
import { z } from 'zod'
import { permissionDefinitionSchema, permissionSchema } from './permissions.js'
import { tenantSummarySchema } from './tenants.js'

const uniquePermissionArraySchema = z.array(permissionSchema).refine(
  (permissions) => new Set(permissions).size === permissions.length,
  'Permissions must be unique.'
)

export const authMethodSchema = z.enum(['passkey', 'email-code', 'oauth'])

export type AuthMethod = z.infer<typeof authMethodSchema>

export const authProviderCapabilitiesSchema = z.object({
  signIn: z.boolean().default(true),
  setup: z.boolean().default(false),
  accountSecurity: z.boolean().default(false),
  adminUserProvisioning: z.boolean().default(false),
  adminUserCredentials: z.boolean().default(false),
  recentVerificationMethods: z.array(authMethodSchema).default([])
})

export type AuthProviderCapabilities = z.infer<typeof authProviderCapabilitiesSchema>

export const authSessionDurationPresetSchema = z.enum(['day', 'week', 'month'])

export type AuthSessionDurationPreset = z.infer<typeof authSessionDurationPresetSchema>

export const AUTH_SESSION_DURATION_MINUTES_MIN = 15

export const authSessionDurationSchema = z.union([
  authSessionDurationPresetSchema,
  z.string()
    .trim()
    .regex(/^custom:\d+$/, 'Custom session durations must use the custom:<minutes> format.')
    .refine((value) => {
      const minutes = Number.parseInt(value.slice('custom:'.length), 10)
      return Number.isInteger(minutes) && minutes >= AUTH_SESSION_DURATION_MINUTES_MIN
    }, `Custom session durations must be at least ${AUTH_SESSION_DURATION_MINUTES_MIN} minutes.`)
])

export type AuthSessionDuration = z.infer<typeof authSessionDurationSchema>

export const authProviderBootstrapSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  methods: z.array(authMethodSchema),
  setupRequired: z.boolean().default(false),
  capabilities: authProviderCapabilitiesSchema.default({
    signIn: true,
    setup: false,
    accountSecurity: false,
    adminUserProvisioning: false,
    adminUserCredentials: false,
    recentVerificationMethods: []
  })
})

export type AuthProviderBootstrap = z.infer<typeof authProviderBootstrapSchema>

export const authProviderEnabledStateSchema = z.object({
  enabled: z.boolean()
})

export type AuthProviderEnabledState = z.infer<typeof authProviderEnabledStateSchema>

export const authActorSummarySchema = z.object({
  type: z.enum(['anonymous', 'user', 'service-account']),
  userId: z.string().optional(),
  serviceAccountId: z.string().optional(),
  email: z.string().email().optional(),
  displayName: z.string().nullable().optional(),
  isPlatformUser: z.boolean().default(false)
})

export type AuthActorSummary = z.infer<typeof authActorSummarySchema>

export const authRuntimePolicySchema = z.object({
  demoMode: z.boolean(),
  /**
   * Managed-bridge mode: the server provisions and owns a single bundled
   * bridge, so the web app hides every bridge-management surface and speaks
   * about printer connectivity as an internal service rather than a "bridge"
   * the operator manages. Set on self-hosted installs that enable
   * `MANAGED_BRIDGE`; false in cloud and remote-bridge installs.
   */
  managedBridge: z.boolean().default(false)
})

export type AuthRuntimePolicy = z.infer<typeof authRuntimePolicySchema>

export const authBootstrapCapabilitiesSchema = z.object({
  canViewAuth: z.boolean(),
  canManageAuthProviders: z.boolean(),
  canManageSettings: z.boolean(),
  canManageSupportAccess: z.boolean(),
  canManageTenants: z.boolean(),
  canManagePlugins: z.boolean(),
  canViewLogs: z.boolean()
})

export type AuthBootstrapCapabilities = z.infer<typeof authBootstrapCapabilitiesSchema>

export const authBootstrapSchema = z.object({
  authEnabled: z.boolean(),
  platformAuthEnabled: z.boolean(),
  setupRequired: z.boolean(),
  providers: z.array(authProviderBootstrapSchema),
  actor: authActorSummarySchema,
  tenant: tenantSummarySchema.nullable().default(null),
  memberTenants: z.array(tenantSummarySchema).default([]),
  availableTenants: z.array(tenantSummarySchema).default([]),
  tenantHasConnectedBridges: z.boolean().default(false),
  permissions: z.array(permissionSchema),
  capabilities: authBootstrapCapabilitiesSchema,
  runtimePolicy: authRuntimePolicySchema
})

export type AuthBootstrap = z.infer<typeof authBootstrapSchema>

const oauthScopeSchema = z.string().trim().min(1).max(120)

export const authOauthProviderConfigSchema = z.object({
  configured: z.boolean(),
  displayName: z.string().trim().min(1).max(120),
  issuerUrl: z.string().url().nullable(),
  clientId: z.string().nullable(),
  clientSecretConfigured: z.boolean(),
  scopes: z.array(oauthScopeSchema)
})

export type AuthOauthProviderConfig = z.infer<typeof authOauthProviderConfigSchema>

export const updateAuthOauthProviderConfigRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  issuerUrl: z.string().trim().url().max(2048),
  clientId: z.string().trim().min(1).max(320),
  clientSecret: z.string().trim().min(1).max(2048).optional(),
  scopes: z.array(oauthScopeSchema).min(1).default(['openid', 'profile', 'email'])
})

export type UpdateAuthOauthProviderConfigRequest = z.infer<typeof updateAuthOauthProviderConfigRequestSchema>

export const updateAuthProviderEnabledRequestSchema = authProviderEnabledStateSchema

export type UpdateAuthProviderEnabledRequest = z.infer<typeof updateAuthProviderEnabledRequestSchema>

export const authSessionSummarySchema = z.object({
  id: z.string(),
  current: z.boolean(),
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime()
})

export type AuthSessionSummary = z.infer<typeof authSessionSummarySchema>

export const authSessionListResponseSchema = z.object({
  sessions: z.array(authSessionSummarySchema)
})

export type AuthSessionListResponse = z.infer<typeof authSessionListResponseSchema>

export const authSessionPolicySchema = z.object({
  sessionDuration: authSessionDurationSchema
})

export type AuthSessionPolicy = z.infer<typeof authSessionPolicySchema>

export const authManagementCountsSchema = z.object({
  users: z.number().int().nonnegative(),
  groups: z.number().int().nonnegative(),
  serviceAccounts: z.number().int().nonnegative()
})

export type AuthManagementCounts = z.infer<typeof authManagementCountsSchema>

export const authManagementCapabilitiesSchema = z.object({
  canViewUsers: z.boolean(),
  canCreateUsers: z.boolean(),
  canEditUsers: z.boolean(),
  canChangeUserEmail: z.boolean(),
  canDisableUserSignIn: z.boolean(),
  canDeleteUsers: z.boolean(),
  canAssignUserRoles: z.boolean(),
  canViewUserSessions: z.boolean(),
  canRevokeUserSessions: z.boolean(),
  canViewUserPasskeys: z.boolean(),
  canEditUserPasskeys: z.boolean(),
  canRevokeUserPasskeys: z.boolean(),
  canViewRoles: z.boolean(),
  canCreateRoles: z.boolean(),
  canEditRoles: z.boolean(),
  canDeleteRoles: z.boolean(),
  canAssignRolePermissions: z.boolean(),
  canViewServiceAccounts: z.boolean(),
  canCreateServiceAccounts: z.boolean(),
  canEditServiceAccounts: z.boolean(),
  canRevokeServiceAccounts: z.boolean(),
  canAssignServiceAccountRoles: z.boolean(),
  canManageSessionPolicy: z.boolean(),
  canManageSupportAccess: z.boolean()
})

export type AuthManagementCapabilities = z.infer<typeof authManagementCapabilitiesSchema>

export const authManagementStatusSchema = z.object({
  sessionDuration: authSessionDurationSchema,
  permissionDefinitions: z.array(permissionDefinitionSchema),
  assignablePermissions: uniquePermissionArraySchema,
  capabilities: authManagementCapabilitiesSchema,
  counts: authManagementCountsSchema
})

export type AuthManagementStatus = z.infer<typeof authManagementStatusSchema>

export const localAuthSessionPolicySchema = authSessionPolicySchema

export type LocalAuthSessionPolicy = AuthSessionPolicy

export const localAuthCountsSchema = authManagementCountsSchema.extend({
  passkeys: z.number().int().nonnegative()
})

export type LocalAuthCounts = z.infer<typeof localAuthCountsSchema>

export const localAuthStatusSchema = z.object({
  setupRequired: z.boolean(),
  sessionDuration: authSessionDurationSchema,
  permissions: z.array(permissionSchema),
  permissionDefinitions: z.array(permissionDefinitionSchema),
  initialAdminEmail: z.string().email().nullable().optional(),
  counts: localAuthCountsSchema
})

export type LocalAuthStatus = z.infer<typeof localAuthStatusSchema>

export const updateAuthSessionPolicyRequestSchema = z.object({
  sessionDuration: authSessionDurationSchema
})

export type UpdateAuthSessionPolicyRequest = z.infer<typeof updateAuthSessionPolicyRequestSchema>

export const updateLocalAuthSessionPolicyRequestSchema = updateAuthSessionPolicyRequestSchema

export type UpdateLocalAuthSessionPolicyRequest = UpdateAuthSessionPolicyRequest

export const bootstrapLocalAdminRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(120).nullable().optional()
})

export type BootstrapLocalAdminRequest = z.infer<typeof bootstrapLocalAdminRequestSchema>

export const authUserInviteResultSchema = z.object({
  delivered: z.boolean(),
  expiresAt: z.string().datetime(),
  previewCode: z.string().nullable()
})

export type AuthUserInviteResult = z.infer<typeof authUserInviteResultSchema>

export const bootstrapLocalAdminResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    displayName: z.string().nullable(),
    createdAt: z.string().datetime()
  }),
  group: z.object({
    id: z.string(),
    key: z.string().nullable(),
    name: z.string()
  }),
  invite: authUserInviteResultSchema,
  setupRequired: z.boolean()
})

export type BootstrapLocalAdminResponse = z.infer<typeof bootstrapLocalAdminResponseSchema>

export const passkeyRegistrationBeginResponseSchema = z.object({
  options: z.unknown()
})

export type PasskeyRegistrationBeginResponse = z.infer<typeof passkeyRegistrationBeginResponseSchema>

export const passkeyRegistrationFinishRequestSchema = z.object({
  response: z.unknown(),
  nickname: z.string().trim().min(1).max(120).nullable().optional()
})

export type PasskeyRegistrationFinishRequest = z.infer<typeof passkeyRegistrationFinishRequestSchema>

export const passkeyRegistrationFinishResponseSchema = z.object({
  credential: z.object({
    id: z.string(),
    nickname: z.string().nullable(),
    createdAt: z.string().datetime()
  }),
  setupRequired: z.boolean()
})

export type PasskeyRegistrationFinishResponse = z.infer<typeof passkeyRegistrationFinishResponseSchema>

export const passkeyAuthenticationBeginResponseSchema = z.object({
  options: z.unknown()
})

export type PasskeyAuthenticationBeginResponse = z.infer<typeof passkeyAuthenticationBeginResponseSchema>

export const passkeyAuthenticationFinishRequestSchema = z.object({
  response: z.unknown()
})

export type PasskeyAuthenticationFinishRequest = z.infer<typeof passkeyAuthenticationFinishRequestSchema>

export const passkeyAuthenticationFinishResponseSchema = z.object({
  authenticated: z.literal(true),
  actor: authActorSummarySchema
})

export type PasskeyAuthenticationFinishResponse = z.infer<typeof passkeyAuthenticationFinishResponseSchema>

export const AUTH_RECENT_VERIFICATION_WINDOW_MINUTES = 10
export const AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE = 'Verify your identity again to continue.'

const authRedirectPathSchema = z.string().trim().min(1).max(512).refine((value) => value.startsWith('/'), {
  message: 'Redirect path must start with /.'
})

export const emailCodeRequestRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  tenantId: z.string().trim().min(1).optional(),
  redirectTo: authRedirectPathSchema.optional(),
  timeZone: z.string().trim().min(1).max(100).optional()
})

export type EmailCodeRequestRequest = z.infer<typeof emailCodeRequestRequestSchema>

export const emailCodeRequestResponseSchema = z.object({
  delivered: z.boolean(),
  requiresTenantSelection: z.boolean().default(false),
  tenants: z.array(tenantSummarySchema).default([]),
  expiresAt: z.string().datetime().nullable(),
  previewCode: z.string().nullable().optional()
})

export type EmailCodeRequestResponse = z.infer<typeof emailCodeRequestResponseSchema>

export const emailCodeVerifyRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  tenantId: z.string().trim().min(1).optional(),
  code: z.string().trim().min(1).max(64)
})

export type EmailCodeVerifyRequest = z.infer<typeof emailCodeVerifyRequestSchema>

export const emailCodeVerifyResponseSchema = z.object({
  authenticated: z.literal(true),
  actor: authActorSummarySchema,
  redirectTo: z.string().nullable().optional()
})

export type EmailCodeVerifyResponse = z.infer<typeof emailCodeVerifyResponseSchema>

export const switchTenantRequestSchema = z.object({
  tenantId: z.string().trim().min(1)
})

export type SwitchTenantRequest = z.infer<typeof switchTenantRequestSchema>

export const selectTenantContextRequestSchema = z.object({
  tenantId: z.string().trim().min(1).nullable()
})

export type SelectTenantContextRequest = z.infer<typeof selectTenantContextRequestSchema>

export const authGroupSchema = z.object({
  id: z.string(),
  key: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  permissions: uniquePermissionArraySchema,
  isSystem: z.boolean(),
  canManage: z.boolean(),
  isEditable: z.boolean(),
  isRemovable: z.boolean(),
  userCount: z.number().int().nonnegative(),
  serviceAccountCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export type AuthGroup = z.infer<typeof authGroupSchema>

export const authGroupSummarySchema = z.object({
  id: z.string(),
  key: z.string().nullable(),
  name: z.string()
})

export type AuthGroupSummary = z.infer<typeof authGroupSummarySchema>

export const authGroupListResponseSchema = z.object({
  groups: z.array(authGroupSchema)
})

export type AuthGroupListResponse = z.infer<typeof authGroupListResponseSchema>

export const createAuthGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: uniquePermissionArraySchema.default([])
})

export type CreateAuthGroupRequest = z.infer<typeof createAuthGroupRequestSchema>

export const updateAuthGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: uniquePermissionArraySchema.optional()
}).refine(
  (value) => value.name !== undefined || value.description !== undefined || value.permissions !== undefined,
  'Expected at least one auth group field to update.'
)

export type UpdateAuthGroupRequest = z.infer<typeof updateAuthGroupRequestSchema>

const uniqueStringArraySchema = z.array(z.string()).refine(
  (values) => new Set(values).size === values.length,
  'Values must be unique.'
)

export const authUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  loginDisabled: z.boolean(),
  isPlatformUser: z.boolean().default(false),
  canManage: z.boolean().optional(),
  groups: z.array(authGroupSummarySchema),
  passkeyCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export type AuthUser = z.infer<typeof authUserSchema>

export const authUserResponseSchema = z.object({
  user: authUserSchema
})

export type AuthUserResponse = z.infer<typeof authUserResponseSchema>

export const authUserListResponseSchema = z.object({
  users: z.array(authUserSchema)
})

export type AuthUserListResponse = z.infer<typeof authUserListResponseSchema>

export const createManagedAuthUserRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(120).nullable().optional(),
  groupIds: uniqueStringArraySchema.default([])
})

export type CreateManagedAuthUserRequest = z.infer<typeof createManagedAuthUserRequestSchema>

export const createAuthUserRequestSchema = createManagedAuthUserRequestSchema.extend({
  sendEmailCode: z.boolean().default(false)
})

export type CreateAuthUserRequest = z.infer<typeof createAuthUserRequestSchema>

export const createAuthUserResponseSchema = z.object({
  user: authUserSchema,
  invite: authUserInviteResultSchema.nullable()
})

export type CreateAuthUserResponse = z.infer<typeof createAuthUserResponseSchema>

export const updateAuthUserRequestSchema = z.object({
  loginDisabled: z.boolean().optional()
}).strict().refine(
  (value) => value.loginDisabled !== undefined,
  'Expected at least one auth user field to update.'
)

export type UpdateAuthUserRequest = z.infer<typeof updateAuthUserRequestSchema>

export const updateCurrentAuthUserRequestSchema = z.object({
  email: z.string().trim().email().max(320).optional(),
  displayName: z.string().trim().min(1).max(120).nullable().optional()
}).refine(
  (value) => value.email !== undefined || value.displayName !== undefined,
  'Expected at least one auth user field to update.'
)

export type UpdateCurrentAuthUserRequest = z.infer<typeof updateCurrentAuthUserRequestSchema>

export const requestCurrentAuthUserEmailChangeRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  timeZone: z.string().trim().min(1).max(100).optional()
})

export type RequestCurrentAuthUserEmailChangeRequest = z.infer<typeof requestCurrentAuthUserEmailChangeRequestSchema>

export const requestCurrentAuthUserEmailChangeResponseSchema = z.object({
  delivered: z.literal(true),
  expiresAt: z.string().datetime(),
  previewCode: z.string().nullable().optional()
})

export type RequestCurrentAuthUserEmailChangeResponse = z.infer<typeof requestCurrentAuthUserEmailChangeResponseSchema>

export const verifyCurrentAuthUserEmailChangeRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  code: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(120).nullable().optional()
})

export type VerifyCurrentAuthUserEmailChangeRequest = z.infer<typeof verifyCurrentAuthUserEmailChangeRequestSchema>

export const authUserPasskeySchema = z.object({
  id: z.string(),
  nickname: z.string().nullable(),
  aaguid: z.string().nullable(),
  transports: z.array(z.string()),
  backedUp: z.boolean(),
  lastUsedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export type AuthUserPasskey = z.infer<typeof authUserPasskeySchema>

export const authUserPasskeyListResponseSchema = z.object({
  passkeys: z.array(authUserPasskeySchema)
})

export type AuthUserPasskeyListResponse = z.infer<typeof authUserPasskeyListResponseSchema>

export const updateAuthUserPasskeyRequestSchema = z.object({
  nickname: z.string().trim().min(1).max(120).nullable()
})

export type UpdateAuthUserPasskeyRequest = z.infer<typeof updateAuthUserPasskeyRequestSchema>

export const updateAuthUserPasskeyResponseSchema = z.object({
  passkey: authUserPasskeySchema
})

export type UpdateAuthUserPasskeyResponse = z.infer<typeof updateAuthUserPasskeyResponseSchema>

export const authUserInviteResponseSchema = z.object({
  invite: authUserInviteResultSchema
})

export type AuthUserInviteResponse = z.infer<typeof authUserInviteResponseSchema>

export const updateAuthUserGroupsRequestSchema = z.object({
  groupIds: uniqueStringArraySchema.default([])
})

export type UpdateAuthUserGroupsRequest = z.infer<typeof updateAuthUserGroupsRequestSchema>

export const authServiceAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenPrefix: z.string(),
  canManage: z.boolean(),
  groups: z.array(authGroupSummarySchema),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export type AuthServiceAccount = z.infer<typeof authServiceAccountSchema>

export const authServiceAccountListResponseSchema = z.object({
  serviceAccounts: z.array(authServiceAccountSchema)
})

export type AuthServiceAccountListResponse = z.infer<typeof authServiceAccountListResponseSchema>

export const createAuthServiceAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  groupIds: uniqueStringArraySchema.default([])
})

export type CreateAuthServiceAccountRequest = z.infer<typeof createAuthServiceAccountRequestSchema>

export const createAuthServiceAccountResponseSchema = z.object({
  serviceAccount: authServiceAccountSchema,
  token: z.string().min(1)
})

export type CreateAuthServiceAccountResponse = z.infer<typeof createAuthServiceAccountResponseSchema>

export const updateAuthServiceAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  groupIds: uniqueStringArraySchema.optional()
}).refine(
  (value) => value.name !== undefined || value.groupIds !== undefined,
  'Expected at least one service account field to update.'
)

export type UpdateAuthServiceAccountRequest = z.infer<typeof updateAuthServiceAccountRequestSchema>