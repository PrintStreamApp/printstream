/**
 * Generic OAuth / OpenID Connect auth provider.
 *
 * This built-in plugin owns a configurable authorization-code + PKCE flow for
 * external identity providers. It authenticates existing users by verified
 * email address, and bootstraps the first auth user as an Admin when no auth
 * users exist yet.
 *
 * Routes:
 * - `GET /api/plugins/auth-oauth/config` — current provider configuration.
 * - `PUT /api/plugins/auth-oauth/config` — update issuer/client settings.
 * - `GET /api/plugins/auth-oauth/authorize` — begin the OAuth redirect flow.
 * - `GET /api/plugins/auth-oauth/callback` — complete the OAuth flow and set
 *   the normal auth session cookie.
 */
import crypto from 'node:crypto'
import {
  AUTH_PROVIDERS_MANAGE_PERMISSION,
  authProviderEnabledStateSchema,
  authOauthProviderConfigSchema,
  updateAuthProviderEnabledRequestSchema,
  updateAuthOauthProviderConfigRequestSchema,
  type AuthOauthProviderConfig,
  type UpdateAuthOauthProviderConfigRequest
} from '@printstream/shared'
import type { Request, Response } from 'express'
import type { ApiPlugin } from '../../plugin/types.js'
import type { RegisteredAuthProvider } from '../../lib/auth-registry.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { assertAuthProviderCanChangeState, restoreSupportAccessWhenWorkspaceAuthDisabled } from '../../lib/auth-provider-guard.js'
import { broadcastAuthChangedForTenant } from '../../lib/auth-change-events.js'
import {
  readScopedAuthProviderEnabled,
  readScopedAuthProviderSetupComplete,
  writeScopedAuthProviderEnabled,
  writeScopedAuthProviderSetupComplete
} from '../../lib/auth-provider-state.js'
import { readAuthSessionMaxAgeSeconds } from '../../lib/auth-policy.js'
import { createUserSession, readRequestCookie, setAuthSessionCookie, setCookieHeader } from '../../lib/auth-session.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { env } from '../../lib/env.js'
import { badRequest, conflict, forbidden } from '../../lib/http-error.js'
import { clearTenantContextCookie, getCurrentTenant, setTenantContextCookie } from '../../lib/tenant-context.js'
import { getSettingScopePrefix } from '../../lib/tenant-settings.js'
import { ensureBuiltInAuthGroups } from '../../lib/default-auth-groups.js'

const DEFAULT_DISPLAY_NAME = 'Single Sign-On'
const DEFAULT_SCOPES = ['openid', 'profile', 'email']
const OAUTH_STATE_COOKIE_NAME = 'printstream_oauth_state'
const OAUTH_VERIFIER_COOKIE_NAME = 'printstream_oauth_verifier'
const OAUTH_REDIRECT_COOKIE_NAME = 'printstream_oauth_redirect'
const OAUTH_NONCE_COOKIE_NAME = 'printstream_oauth_nonce'
const OAUTH_FLOW_MAX_AGE_SECONDS = 10 * 60

interface OidcDiscoveryDocument {
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
}

interface StoredOauthConfig {
  displayName: string
  issuerUrl: string | null
  clientId: string | null
  clientSecret: string | null
  scopes: string[]
  configured: boolean
}

type FetchLike = typeof fetch

interface AuthOauthPluginDeps {
  ensureDefaultGroups(prisma: AnyPrismaClient): Promise<void>
  fetch: FetchLike
}

const defaultDeps: AuthOauthPluginDeps = {
  ensureDefaultGroups: ensureBuiltInAuthGroups,
  fetch: globalThis.fetch.bind(globalThis)
}

export function createAuthOauthPlugin(overrides: Partial<AuthOauthPluginDeps> = {}): ApiPlugin {
  const deps: AuthOauthPluginDeps = {
    ...defaultDeps,
    ...overrides
  }

  return {
    name: 'auth-oauth',
    version: '0.1.0',
    description: 'Generic OpenID Connect sign-in for external identity providers.',
    async register(context) {
      const buildProvider = async (): Promise<RegisteredAuthProvider> => {
        const config = await readOauthConfig(context.settings)
        const setupComplete = await readScopedAuthProviderSetupComplete(context.settings)
        return {
          id: 'auth-oauth',
          label: config.displayName,
          enabled: await readScopedAuthProviderEnabled(context.settings),
          methods: ['oauth'],
          setupRequired: !config.configured || !setupComplete,
          capabilities: {
            signIn: true,
            setup: true,
            accountSecurity: false,
            adminUserProvisioning: false,
            adminUserCredentials: false,
            recentVerificationMethods: []
          }
        }
      }

      context.registerAuthProvider(buildProvider)

      context.router.get('/enabled', requireRequestPermission(AUTH_PROVIDERS_MANAGE_PERMISSION), async (_request, response) => {
        response.json(authProviderEnabledStateSchema.parse({
          enabled: await readScopedAuthProviderEnabled(context.settings)
        }))
      })

      context.router.post('/enabled', requireRequestPermission(AUTH_PROVIDERS_MANAGE_PERMISSION), async (request, response) => {
        const parsed = updateAuthProviderEnabledRequestSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid auth provider state payload.')
        }

        const currentEnabled = await readScopedAuthProviderEnabled(context.settings)
        if (parsed.data.enabled !== currentEnabled) {
          await assertAuthProviderCanChangeState({
            providerId: 'auth-oauth',
            currentEnabled,
            nextEnabled: parsed.data.enabled,
            tenant: request.tenant ?? null,
            isPlatformUser: request.auth.actor.type === 'user' && (request.auth.actor.isPlatformUser ?? false)
          })
          await writeScopedAuthProviderEnabled(context.settings, parsed.data.enabled)
          await restoreSupportAccessWhenWorkspaceAuthDisabled({
            tenant: request.tenant ?? null,
            nextEnabled: parsed.data.enabled,
            isPlatformUser: request.auth.actor.type === 'user' && (request.auth.actor.isPlatformUser ?? false)
          })
          broadcastAuthChangedForTenant(request.tenant?.id)
        }

        annotateRequestAuditLog(request, {
          action: parsed.data.enabled ? 'enable-auth-provider' : 'disable-auth-provider',
          resource: 'auth provider',
          summary: `${parsed.data.enabled ? 'Enabled' : 'Disabled'} the Single Sign-On auth provider.`,
          metadata: {
            provider: 'auth-oauth',
            enabled: parsed.data.enabled
          }
        })

        response.json(authProviderEnabledStateSchema.parse({ enabled: parsed.data.enabled }))
      })

      context.router.get('/config', requireRequestPermission(AUTH_PROVIDERS_MANAGE_PERMISSION), async (_request, response) => {
        response.json(authOauthProviderConfigSchema.parse(toOauthConfigDto(await readOauthConfig(context.settings))))
      })

      context.router.put('/config', requireRequestPermission(AUTH_PROVIDERS_MANAGE_PERMISSION), async (request, response) => {
        const parsed = updateAuthOauthProviderConfigRequestSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid OAuth provider configuration.')
        }

        await writeOauthConfig(context.settings, parsed.data)
        broadcastAuthChangedForTenant(request.tenant?.id)

        const dto = toOauthConfigDto(await readOauthConfig(context.settings))
        // Record the non-secret config surface. The clientSecret is never
        // logged or audited — only whether one is configured.
        annotateRequestAuditLog(request, {
          action: 'update-auth-provider-config',
          resource: 'auth provider configuration',
          summary: 'Updated the Single Sign-On auth provider configuration.',
          metadata: {
            provider: 'auth-oauth',
            issuerUrl: dto.issuerUrl,
            clientId: dto.clientId,
            clientSecretConfigured: dto.clientSecretConfigured
          }
        })

        response.json(authOauthProviderConfigSchema.parse(dto))
      })

      context.router.get('/authorize', async (request, response) => {
        try {
          if (!(await readScopedAuthProviderEnabled(context.settings))) {
            throw conflict('Single Sign-On is not enabled in this workspace.')
          }

          const config = await readOauthConfig(context.settings)
          if (!config.configured || !config.issuerUrl || !config.clientId || !config.clientSecret) {
            throw conflict('Single Sign-On is not configured yet.')
          }

          const redirectTo = sanitizeRedirectPath(typeof request.query.redirectTo === 'string' ? request.query.redirectTo : null)
          const discovery = await discoverOidcConfiguration(deps.fetch, config.issuerUrl)
          const state = crypto.randomBytes(24).toString('base64url')
          const nonce = crypto.randomBytes(24).toString('base64url')
          const verifier = crypto.randomBytes(48).toString('base64url')
          const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
          const callbackUrl = buildCallbackUrl(request)
          const authorizationUrl = new URL(discovery.authorizationEndpoint)

          authorizationUrl.searchParams.set('response_type', 'code')
          authorizationUrl.searchParams.set('client_id', config.clientId)
          authorizationUrl.searchParams.set('redirect_uri', callbackUrl)
          authorizationUrl.searchParams.set('scope', config.scopes.join(' '))
          authorizationUrl.searchParams.set('state', state)
          authorizationUrl.searchParams.set('nonce', nonce)
          authorizationUrl.searchParams.set('code_challenge', challenge)
          authorizationUrl.searchParams.set('code_challenge_method', 'S256')

          setCookieHeader(response, OAUTH_STATE_COOKIE_NAME, state, OAUTH_FLOW_MAX_AGE_SECONDS)
          setCookieHeader(response, OAUTH_VERIFIER_COOKIE_NAME, verifier, OAUTH_FLOW_MAX_AGE_SECONDS)
          setCookieHeader(response, OAUTH_NONCE_COOKIE_NAME, nonce, OAUTH_FLOW_MAX_AGE_SECONDS)
          setCookieHeader(response, OAUTH_REDIRECT_COOKIE_NAME, redirectTo, OAUTH_FLOW_MAX_AGE_SECONDS)

          response.redirect(302, authorizationUrl.toString())
        } catch (error) {
          redirectToAuthError(response, extractOauthErrorMessage(error))
        }
      })

      context.router.get('/callback', async (request, response) => {
        try {
          if (!(await readScopedAuthProviderEnabled(context.settings))) {
            throw conflict('Single Sign-On is not enabled in this workspace.')
          }

          const config = await readOauthConfig(context.settings)
          if (!config.configured || !config.issuerUrl || !config.clientId || !config.clientSecret) {
            throw conflict('Single Sign-On is not configured yet.')
          }

          const code = typeof request.query.code === 'string' ? request.query.code.trim() : ''
          const state = typeof request.query.state === 'string' ? request.query.state.trim() : ''
          if (!code || !state) {
            throw badRequest('Missing OAuth authorization response details.')
          }

          const expectedState = readRequestCookie(request, OAUTH_STATE_COOKIE_NAME)
          const verifier = readRequestCookie(request, OAUTH_VERIFIER_COOKIE_NAME)
          const redirectTo = sanitizeRedirectPath(readRequestCookie(request, OAUTH_REDIRECT_COOKIE_NAME))
          clearOauthFlowCookies(response)

          if (!expectedState || !verifier || state !== expectedState) {
            throw forbidden('The OAuth sign-in attempt could not be verified. Try again.')
          }

          const discovery = await discoverOidcConfiguration(deps.fetch, config.issuerUrl)
          const callbackUrl = buildCallbackUrl(request)
          const token = await exchangeAuthorizationCode(deps.fetch, discovery, config, code, verifier, callbackUrl)
          const profile = await fetchUserInfo(deps.fetch, discovery, token.accessToken)
          const email = extractVerifiedEmail(profile)

          if (!email) {
            throw forbidden('The identity provider did not return a verified email address.')
          }

          const user = await findOrProvisionOauthUser(context.prisma, {
            email,
            displayName: extractDisplayName(profile)
          })
          if (!user) {
            throw forbidden('No auth user is provisioned for this identity.')
          }
          if (user.loginDisabled) {
            throw forbidden('Sign-in is disabled for this account.')
          }

          const session = await createUserSession(context.prisma, user.id, {
            request,
            maxAgeSeconds: await readAuthSessionMaxAgeSeconds(context.prisma)
          })
          await writeScopedAuthProviderSetupComplete(context.settings, true)
          setAuthSessionCookie(response, session.secret, session.expiresAt)
          const nextTenantId = resolvePostSignInTenantId(user)
          if (nextTenantId) {
            setTenantContextCookie(response, nextTenantId)
          } else {
            clearTenantContextCookie(response)
          }
          response.redirect(302, buildClientRedirect(redirectTo))
        } catch (error) {
          clearOauthFlowCookies(response)
          redirectToAuthError(response, extractOauthErrorMessage(error))
        }
      })
    }
  }
}

export const authOauthPlugin = createAuthOauthPlugin()

async function readOauthConfig(settings: { get(key: string): Promise<string | null> }): Promise<StoredOauthConfig> {
  const [displayName, issuerUrl, clientId, clientSecret, scopes] = await Promise.all([
    readScopedOauthSetting(settings, 'displayName'),
    readScopedOauthSetting(settings, 'issuerUrl'),
    readScopedOauthSetting(settings, 'clientId'),
    readScopedOauthSetting(settings, 'clientSecret'),
    readScopedOauthSetting(settings, 'scopes')
  ])

  const normalizedScopes = parseStoredScopes(scopes)

  return {
    displayName: displayName?.trim() || DEFAULT_DISPLAY_NAME,
    issuerUrl: issuerUrl?.trim() || null,
    clientId: clientId?.trim() || null,
    clientSecret: clientSecret?.trim() || null,
    scopes: normalizedScopes,
    configured: Boolean(issuerUrl?.trim() && clientId?.trim() && clientSecret?.trim())
  }
}

async function writeOauthConfig(
  settings: { set(key: string, value: string): Promise<void> },
  input: UpdateAuthOauthProviderConfigRequest
): Promise<void> {
  await Promise.all([
    settings.set(scopedOauthSettingKey('displayName'), input.displayName.trim()),
    settings.set(scopedOauthSettingKey('issuerUrl'), input.issuerUrl.trim()),
    settings.set(scopedOauthSettingKey('clientId'), input.clientId.trim()),
    settings.set(scopedOauthSettingKey('clientSecret'), input.clientSecret?.trim() ?? ''),
    settings.set(scopedOauthSettingKey('scopes'), JSON.stringify(normalizeScopes(input.scopes)))
  ])
}

async function readScopedOauthSetting(
  settings: { get(key: string): Promise<string | null> },
  key: string
): Promise<string | null> {
  const scopedValue = await settings.get(scopedOauthSettingKey(key))
  if (scopedValue != null) {
    return scopedValue
  }

  // Preserve existing platform config written before auth settings became
  // surface-scoped, while keeping tenant workspaces isolated from that state.
  if (getCurrentTenant()) {
    return null
  }

  return await settings.get(key)
}

function scopedOauthSettingKey(key: string): string {
  return `${getSettingScopePrefix()}:${key}`
}

function toOauthConfigDto(config: StoredOauthConfig): AuthOauthProviderConfig {
  return {
    configured: config.configured,
    displayName: config.displayName,
    issuerUrl: config.issuerUrl,
    clientId: config.clientId,
    clientSecretConfigured: Boolean(config.clientSecret),
    scopes: config.scopes
  }
}

function parseStoredScopes(value: string | null): string[] {
  if (!value) {
    return [...DEFAULT_SCOPES]
  }

  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return normalizeScopes(parsed.filter((entry): entry is string => typeof entry === 'string'))
    }
  } catch {
    return normalizeScopes(value.split(/\s+/g))
  }

  return [...DEFAULT_SCOPES]
}

function normalizeScopes(scopes: string[]): string[] {
  const normalized = Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)))
  return normalized.length > 0 ? normalized : [...DEFAULT_SCOPES]
}

async function discoverOidcConfiguration(fetchImpl: FetchLike, issuerUrl: string): Promise<OidcDiscoveryDocument> {
  const response = await fetchImpl(`${issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
    headers: { Accept: 'application/json' }
  })
  if (!response.ok) {
    throw badRequest(`The OAuth provider discovery document could not be loaded (${response.status}).`)
  }

  const payload = await response.json() as Record<string, unknown>
  const authorizationEndpoint = typeof payload.authorization_endpoint === 'string' ? payload.authorization_endpoint : null
  const tokenEndpoint = typeof payload.token_endpoint === 'string' ? payload.token_endpoint : null
  const userinfoEndpoint = typeof payload.userinfo_endpoint === 'string' ? payload.userinfo_endpoint : null
  if (!authorizationEndpoint || !tokenEndpoint || !userinfoEndpoint) {
    throw badRequest('The OAuth provider is missing a required discovery endpoint.')
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    userinfoEndpoint
  }
}

async function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  discovery: OidcDiscoveryDocument,
  config: StoredOauthConfig,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<{ accessToken: string }> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: config.clientId ?? ''
  })
  const response = await fetchImpl(discovery.tokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })
  if (!response.ok) {
    throw forbidden('The OAuth provider rejected the authorization code.')
  }

  const payload = await response.json() as Record<string, unknown>
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null
  if (!accessToken) {
    throw forbidden('The OAuth provider did not return an access token.')
  }
  return { accessToken }
}

async function fetchUserInfo(fetchImpl: FetchLike, discovery: OidcDiscoveryDocument, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(discovery.userinfoEndpoint, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  })
  if (!response.ok) {
    throw forbidden('The OAuth provider user profile could not be loaded.')
  }
  return await response.json() as Record<string, unknown>
}

function extractVerifiedEmail(profile: Record<string, unknown>): string | null {
  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : ''
  const verified = profile.email_verified
  const emailVerified = verified === true || verified === 'true'
  return email && emailVerified ? email : null
}

function extractDisplayName(profile: Record<string, unknown>): string | null {
  const candidates = [profile.name, profile.preferred_username, profile.given_name]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 120)
    }
  }
  return null
}

async function findOrProvisionOauthUser(
  prisma: AnyPrismaClient,
  input: { email: string; displayName: string | null }
): Promise<{ id: string; loginDisabled: boolean; isPlatformUser: boolean; tenantMemberships: Array<{ tenantId: string; loginDisabled: boolean }> } | null> {
  const tenant = getCurrentTenant()

  const existing = await prisma.authUser.findFirst({
    where: {
      email: {
        equals: input.email,
        mode: 'insensitive'
      }
    },
    select: {
      id: true,
      isPlatformUser: true,
      tenantMemberships: tenant
        ? {
            where: {
              tenantId: tenant.id
            },
            select: {
              loginDisabled: true
            }
          }
        : false
    }
  })
  if (tenant && existing?.tenantMemberships[0]) {
    return {
      id: existing.id,
      loginDisabled: existing.tenantMemberships[0].loginDisabled,
      isPlatformUser: existing.isPlatformUser,
      tenantMemberships: existing.tenantMemberships.map((m) => ({ tenantId: tenant.id, loginDisabled: m.loginDisabled }))
    }
  }
  if (!tenant && existing?.isPlatformUser) {
    return {
      id: existing.id,
      loginDisabled: false,
      isPlatformUser: true,
      tenantMemberships: []
    }
  }

  const userCount = tenant
    ? await prisma.authTenantMembership.count({
        where: {
          tenantId: tenant.id
        }
      })
    : await prisma.authUser.count({
        where: {
          isPlatformUser: true
        }
      })
  if (userCount > 0) {
    return null
  }

  if (tenant) {
    await ensureBuiltInAuthGroups(prisma, tenant.id)
  }

  const adminGroup = tenant
    ? await prisma.authGroup.findUnique({
      where: {
        tenantId_key: {
          tenantId: tenant.id,
          key: 'admin'
        }
      }
    })
    : null

  const userId = existing?.id ?? (await prisma.authUser.create({
    data: {
      email: input.email,
      displayName: input.displayName,
      isPlatformUser: tenant ? false : true
    },
    select: {
      id: true
    }
  })).id

  if (!tenant) {
    if (existing && !existing.isPlatformUser) {
      await prisma.authUser.update({
        where: { id: existing.id },
        data: {
          isPlatformUser: true
        }
      })
    }

    return {
      id: userId,
      loginDisabled: false,
      isPlatformUser: true,
      tenantMemberships: []
    }
  }

  await prisma.authTenantMembership.create({
    data: {
      userId,
      tenantId: tenant.id
    }
  })

  if (adminGroup) {
    await prisma.authUserGroupMembership.create({
      data: {
        userId,
        groupId: adminGroup.id
      }
    })
  }

  return {
    id: userId,
    loginDisabled: false,
    isPlatformUser: false,
    tenantMemberships: [{ tenantId: tenant.id, loginDisabled: false }]
  }
}

function resolvePostSignInTenantId(user: {
  isPlatformUser: boolean
  tenantMemberships: Array<{ tenantId: string; loginDisabled: boolean }>
}): string | null {
  const currentTenantId = getCurrentTenant()?.id ?? null
  const enabledMemberships = user.tenantMemberships.filter((m) => !m.loginDisabled)

  if (currentTenantId && enabledMemberships.some((m) => m.tenantId === currentTenantId)) {
    return currentTenantId
  }

  if (!user.isPlatformUser && enabledMemberships.length === 1) {
    return enabledMemberships[0]?.tenantId ?? null
  }

  return null
}

function sanitizeRedirectPath(value: string | null): string {
  if (!value || !value.startsWith('/')) {
    return '/auth'
  }
  return value.slice(0, 512)
}

function buildCallbackUrl(request: Request): string {
  const baseUrl = env.PUBLIC_BASE_URL?.trim() || `${request.protocol}://${request.get('host')}`
  return new URL('/api/plugins/auth-oauth/callback', baseUrl).toString()
}

function buildClientRedirect(path: string): string {
  return new URL(path, env.CLIENT_ORIGIN).toString()
}

function buildClientAuthErrorUrl(message: string): string {
  const url = new URL('/auth', env.CLIENT_ORIGIN)
  url.searchParams.set('error', message)
  return url.toString()
}

function redirectToAuthError(response: Response, message: string): void {
  response.redirect(302, buildClientAuthErrorUrl(message))
}

function extractOauthErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return 'Single Sign-On could not be completed.'
}

function clearOauthFlowCookies(response: Response): void {
  setCookieHeader(response, OAUTH_STATE_COOKIE_NAME, '', 0)
  setCookieHeader(response, OAUTH_VERIFIER_COOKIE_NAME, '', 0)
  setCookieHeader(response, OAUTH_REDIRECT_COOKIE_NAME, '', 0)
  setCookieHeader(response, OAUTH_NONCE_COOKIE_NAME, '', 0)
}