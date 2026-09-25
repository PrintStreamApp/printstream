/**
 * User-initiated support relay from a self-hosted install to its licence issuer.
 * It owns no timer or background work: a vendor request exists only while a
 * person is actively using the support UI.
 */
import express, { type NextFunction, type Request, type Router } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  SELF_HOSTED_SUPPORT_CONTEXT_HEADER,
  SELF_HOSTED_SUPPORT_INSTALLATION_HEADER,
  SELF_HOSTED_SUPPORT_LICENSE_HEADER,
  SUPPORT_ATTACHMENT_CHUNK_BYTES,
  canUseSuggestions,
  hasInAppSupport,
  inAppSupportUnavailabilityReason,
  type LicenseStatus,
  type SelfHostedSupportContext
} from '@printstream/shared'
import { annotateRequestAuditLog, skipRequestAuditLog } from '../../lib/audit-logs.js'
import { getAppBuildInfo } from '../../lib/app-build-info.js'
import { AUTHENTICATION_REQUIRED_MESSAGE } from '../../lib/authorization.js'
import { getInstallationId } from '../../lib/installation-id.js'
import { HttpError, forbidden, unauthorized } from '../../lib/http-error.js'
import { resolveLicenseRefreshOrigin } from '../../lib/license-origin.js'
import { getInstalledLicenseKey, getInstalledLicenseStatus } from '../../lib/license-state.js'

const CLOUD_SUPPORT_PATH = '/api/self-hosted/support'
const CLOUD_SUGGESTIONS_PATH = '/api/self-hosted/suggestions'

function isChunkPath(request: Request): boolean {
  return request.method === 'POST' && /\/attachments\/uploads\/[^/]+\/chunks$/.test(request.path)
}

/** Parse upload chunks without buffering any other relayed request as bytes. */
function installChunkParser(router: Router): void {
  router.use('/support', (request, response, next) => {
    if (!isChunkPath(request)) {
      next()
      return
    }
    express.raw({ type: 'application/octet-stream', limit: SUPPORT_ATTACHMENT_CHUNK_BYTES })(request, response, next)
  })
}

async function relayContext(request: Request): Promise<SelfHostedSupportContext> {
  return {
    workspaceId: request.workspace?.id ?? null,
    workspaceName: request.workspace?.name ?? null,
    appVersion: getAppBuildInfo().revision ?? getAppBuildInfo().version ?? null,
    userAgent: request.get('user-agent') ?? null
  }
}

/**
 * Permit signed-in people and the implicit administrator of an auth-disabled
 * install. Public demo guests and service accounts never represent a customer
 * who deliberately opened an interactive support surface.
 */
function requireCloudConnectionUser(request: Request, _response: express.Response, next: NextFunction): void {
  try {
    const actor = request.auth.actor
    const isAuthDisabledAdministrator = actor.type === 'anonymous'
      && !request.auth.authEnabled
      && request.auth.publicDemoGuest !== true

    if (actor.type !== 'user' && !isAuthDisabledAdministrator) {
      throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
    }
    next()
  } catch (error) {
    next(error)
  }
}

function outgoingBody(request: Request): BodyInit | undefined {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  if (Buffer.isBuffer(request.body)) return request.body as unknown as BodyInit
  return request.body === undefined ? undefined : JSON.stringify(request.body)
}

function copyResponseHeaders(upstream: Response, response: express.Response): void {
  // Fetch transparently decodes gzip/br responses while retaining their
  // original Content-Length. Let Node frame the decoded stream itself or the
  // browser can truncate it at the compressed byte count.
  for (const name of ['content-type', 'content-disposition', 'cache-control', 'retry-after']) {
    const value = upstream.headers.get(name)
    if (value) response.setHeader(name, value)
  }
}

/**
 * Build the vendor URL without leaking the browser's local workspace selector.
 *
 * `apiFetch` appends `workspace` to every workspace-scoped local request so the
 * self-hosted API can resolve the current workspace. The cloud API has its own
 * workspace resolver, where that same slug names an unrelated cloud workspace
 * and normally produces a 404 before the licence-authenticated relay route can
 * run. Every other query parameter belongs to the relayed feature and must be
 * preserved.
 */
function cloudRelayTarget(origin: string, cloudPath: string, requestUrl: string): URL {
  const target = new URL(`${cloudPath}${requestUrl}`, origin)
  target.searchParams.delete('workspace')
  return target
}

/** Injectable boundaries for the local cloud relay. */
export interface CloudSupportRelayDependencies {
  getLicenseKey?: () => Promise<string | null>
  getLicenseStatus?: () => Promise<LicenseStatus>
  getInstallationId?: () => Promise<string>
  resolveOrigin?: (key: string) => string
  resolveContext?: (request: Request) => Promise<SelfHostedSupportContext>
  fetch?: typeof fetch
}

interface CloudRelayRoute {
  localPath: string
  cloudPath: string
  auditResource: string
  unreachableMessage: string
  includeSupportContext: boolean
}

/** Register one interactive, user-initiated path through the local relay. */
function registerCloudRelay(
  router: Router,
  route: CloudRelayRoute,
  dependencies: CloudSupportRelayDependencies
): void {
  router.use(route.localPath, requireCloudConnectionUser, async (request, response, next) => {
    try {
      const [key, status, installationId, context] = await Promise.all([
        (dependencies.getLicenseKey ?? getInstalledLicenseKey)(),
        (dependencies.getLicenseStatus ?? getInstalledLicenseStatus)(),
        (dependencies.getInstallationId ?? getInstallationId)(),
        route.includeSupportContext
          ? (dependencies.resolveContext ?? relayContext)(request)
          : Promise.resolve(null)
      ])
      // Only a person using the feature can reach this relay. Help needs a
      // current support entitlement; Suggestions needs any valid installed key.
      if (!key || (route.includeSupportContext ? !hasInAppSupport(status) : !canUseSuggestions(status))) {
        const reason = route.includeSupportContext
          ? inAppSupportUnavailabilityReason(status)
          : 'Suggestions require a valid installed licence.'
        throw forbidden(reason ?? 'This cloud feature is unavailable for the installed licence.')
      }

      if (isChunkPath(request)) {
        skipRequestAuditLog(request)
      } else if (request.method !== 'GET' && request.method !== 'HEAD') {
        annotateRequestAuditLog(request, {
          action: `cloud-${route.auditResource}.request`,
          resource: route.auditResource,
          summary: `Sent a ${route.auditResource} request to PrintStream Cloud.`,
          metadata: { method: request.method, path: request.path }
        })
      }

      const target = cloudRelayTarget(
        (dependencies.resolveOrigin ?? resolveLicenseRefreshOrigin)(key),
        route.cloudPath,
        request.url
      )
      const upstream = await (dependencies.fetch ?? fetch)(target, {
        method: request.method,
        headers: {
          accept: request.get('accept') ?? 'application/json',
          ...(request.body !== undefined ? { 'content-type': request.get('content-type') ?? 'application/json' } : {}),
          ...(request.get('x-upload-offset') ? { 'x-upload-offset': request.get('x-upload-offset')! } : {}),
          [SELF_HOSTED_SUPPORT_LICENSE_HEADER]: key,
          [SELF_HOSTED_SUPPORT_INSTALLATION_HEADER]: installationId,
          ...(context
            ? { [SELF_HOSTED_SUPPORT_CONTEXT_HEADER]: Buffer.from(JSON.stringify(context)).toString('base64url') }
            : {})
        },
        body: outgoingBody(request),
        signal: AbortSignal.timeout(120_000)
      })

      copyResponseHeaders(upstream, response)
      response.status(upstream.status)
      if (!upstream.body) {
        response.end()
        return
      }
      await pipeline(
        Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]),
        response
      )
    } catch (error) {
      if (error instanceof HttpError) {
        next(error)
        return
      }
      console.warn('[cloud-connection] relay request failed', {
        service: route.auditResource,
        method: request.method,
        path: request.path,
        error: error instanceof Error ? error.message : String(error)
      })
      next(new HttpError(502, route.unreachableMessage))
    }
  })
}

/** Register the local half of the cloud-support relay. */
export function registerCloudSupportRelay(router: Router, dependencies: CloudSupportRelayDependencies = {}): void {
  installChunkParser(router)
  registerCloudRelay(router, {
    localPath: '/support',
    cloudPath: CLOUD_SUPPORT_PATH,
    auditResource: 'support',
    unreachableMessage: 'PrintStream Cloud could not be reached. You can still contact support by email.',
    includeSupportContext: true
  }, dependencies)
}

/** Register the Customer-attributed suggestion-board relay. */
export function registerCloudSuggestionRelay(router: Router, dependencies: CloudSupportRelayDependencies = {}): void {
  registerCloudRelay(router, {
    localPath: '/suggestions',
    cloudPath: CLOUD_SUGGESTIONS_PATH,
    auditResource: 'suggestions',
    unreachableMessage: 'The PrintStream suggestion board could not be reached.',
    includeSupportContext: false
  }, dependencies)
}

/** Register every user-initiated cloud path contributed by this plugin. */
export function registerCloudConnectionRelays(router: Router): void {
  registerCloudSupportRelay(router)
  registerCloudSuggestionRelay(router)
}
