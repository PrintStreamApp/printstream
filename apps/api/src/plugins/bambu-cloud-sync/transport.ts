/**
 * Where a Bambu cloud call is made from: the workspace's own bridge when one can take
 * it, this server otherwise.
 *
 * Owns only the routing decision and the fallback. It does not build URLs (the bridge
 * relay and `directBambuCloudRequest` do) and it does not interpret responses (the
 * client does), a non-2xx answer is a successful relay, not a transport failure.
 *
 * **Bridge-preferred, and why.** On a multi-workspace deployment every workspace would
 * otherwise reach Bambu from one shared egress IP. Bambu's edge rate-limits and
 * Cloudflare-challenges per IP, so one workspace with many presets would degrade the
 * feature for every other workspace, and the whole deployment would look like a single
 * abusive client. A bridge puts a household's traffic on that household's own
 * connection. The direct path exists because a workspace may have no bridge, its
 * bridge may be offline, or it may be too old to know the method.
 *
 * Counterpart: `apps/bridge/src/bambu-cloud-relay.ts`.
 */
import {
  BAMBU_CLOUD_ALLOWED_HOSTS,
  BAMBU_CLOUD_BODY_TEXT_LIMIT,
  BAMBU_SLICER_API_VERSION,
  bambuCloudHosts,
  bambuCloudResponseSchema,
  isUnsupportedBridgeRpcError,
  type BambuCloudRequest,
  type BambuCloudResponse
} from '@printstream/shared'
import { bridgeSessionManager } from '../../lib/bridge-session-manager.js'
import { assertSafeOutboundUrl } from '../../lib/outbound-url-guard.js'
import { rootPrisma } from '../../lib/prisma.js'
import type { PluginLogger } from '../../plugin/types.js'

/** Same honest client identity the bridge relay presents; see the note there. */
const USER_AGENT = 'PrintStream/1.0 (+https://printstream.app)'
const REQUEST_TIMEOUT_MS = 20_000
/** Generous: the relay's own HTTP timeout is 20s and the RPC has to outlive it. */
const BRIDGE_RPC_TIMEOUT_MS = 30_000

export type BambuCloudCallRoute = 'bridge' | 'direct'

export interface BambuCloudCallResult {
  response: BambuCloudResponse
  /** Which path served it, for the "synced via your bridge" line in the UI. */
  route: BambuCloudCallRoute
}

/**
 * Runs one cloud call, preferring the workspace's bridge.
 *
 * Falls back to a direct call when there is no connected bridge, when the bridge is
 * too old to know the method, or when the RPC itself fails (a dropped session mid-call).
 * A fallback is logged at info: silently re-routing every workspace's traffic through
 * the shared IP is exactly the situation this design exists to avoid, so it should be
 * visible in the logs rather than inferred from Bambu's rate limiting.
 */
export async function performBambuCloudCall(
  workspaceId: string,
  request: BambuCloudRequest,
  logger: PluginLogger,
  signal?: AbortSignal
): Promise<BambuCloudCallResult> {
  const bridgeId = await findConnectedBridgeId(workspaceId)
  if (bridgeId) {
    try {
      const result = await bridgeSessionManager.requestRpc<unknown>(
        bridgeId,
        'bambu.cloud.request',
        request,
        { timeoutMs: BRIDGE_RPC_TIMEOUT_MS }
      )
      return { response: bambuCloudResponseSchema.parse(result), route: 'bridge' }
    } catch (error) {
      const reason = isUnsupportedBridgeRpcError(error)
        ? 'the bridge is too old to relay Bambu cloud calls'
        : (error as Error).message
      logger.info(`Bambu cloud call fell back to a direct server call (${reason})`)
    }
  }

  return { response: await directBambuCloudRequest(request, signal), route: 'direct' }
}

/**
 * The workspace's bridge, if one is connected right now.
 *
 * `Bridge` is not workspace-scoped by Prisma, so the workspace filter is explicit.
 * Returns null rather than throwing when nothing is available: having no bridge is a
 * normal state, not a sync failure.
 */
async function findConnectedBridgeId(workspaceId: string): Promise<string | null> {
  const bridges = await rootPrisma.bridge.findMany({ where: { workspaceId }, select: { id: true } })
  return bridges.find((bridge) => bridgeSessionManager.isConnected(bridge.id))?.id ?? null
}

/**
 * The server-side path, used when no bridge can take the call.
 *
 * Mirrors the bridge relay's URL construction deliberately rather than sharing it: the
 * two run in different processes with different deploy cadences, and the shared piece
 * that matters (which operations exist, and their payloads) is already the operation
 * union in `@printstream/shared`. Every URL is checked by `assertSafeOutboundUrl` with
 * the host list pinned to Bambu's, matching the firmware-download posture.
 */
export async function directBambuCloudRequest(
  request: BambuCloudRequest,
  signal?: AbortSignal
): Promise<BambuCloudResponse> {
  const hosts = bambuCloudHosts(request.region)

  if (request.request.operation === 'verifyTotp') {
    const csrf = await fetchCsrfToken(hosts.web, signal)
    if (!csrf) {
      return {
        status: 0,
        body: null,
        bodyText: 'Could not obtain a security token from Bambu Cloud (GET /api/csrf returned no bbl_csrf_token).'
      }
    }
    return await execute(
      `https://${hosts.web}/api/sign-in/tfa`,
      'POST',
      { tfaKey: request.request.tfaKey, tfaCode: request.request.code },
      { 'x-bbl-csrf-token': csrf.token, cookie: csrf.cookie },
      signal
    )
  }

  const settingBase = `https://${hosts.api}/v1/iot-service/api/slicer/setting`
  const versionQuery = `?version=${encodeURIComponent(BAMBU_SLICER_API_VERSION)}`
  const loginUrl = `https://${hosts.api}/v1/user-service/user/login`
  const authHeaders: Record<string, string> = request.accessToken ? { authorization: `Bearer ${request.accessToken}` } : {}

  switch (request.request.operation) {
    case 'login':
      return await execute(loginUrl, 'POST', { account: request.request.account, password: request.request.password }, {}, signal)
    case 'verifyEmailCode':
      return await execute(loginUrl, 'POST', { account: request.request.account, code: request.request.code }, {}, signal)
    case 'listSettings':
      return await execute(`${settingBase}${versionQuery}`, 'GET', undefined, authHeaders, signal)
    case 'getSetting':
      return await execute(`${settingBase}/${encodeURIComponent(request.request.settingId)}${versionQuery}`, 'GET', undefined, authHeaders, signal)
    case 'createSetting':
      return await execute(`${settingBase}${versionQuery}`, 'POST', request.request.payload, authHeaders, signal)
    case 'patchSetting':
      return await execute(`${settingBase}/${encodeURIComponent(request.request.settingId)}${versionQuery}`, 'PATCH', request.request.payload, authHeaders, signal)
    case 'deleteSetting':
      return await execute(`${settingBase}/${encodeURIComponent(request.request.settingId)}${versionQuery}`, 'DELETE', undefined, authHeaders, signal)
    case 'refreshToken':
      // No auth header on purpose: the access token this would carry is the expired one.
      return await execute(`https://${hosts.api}/v1/user-service/user/refreshtoken`, 'POST', { refreshToken: request.request.refreshToken }, {}, signal)
    default: {
      // Compile-time exhaustiveness: this file and the bridge relay each switch over the
      // same operation union in two different processes, so adding an operation to the
      // shared schema without updating BOTH would otherwise only surface at runtime, on
      // whichever path happened to be taken. This makes the omission a typecheck failure.
      const unhandled: never = request.request
      throw new Error(`Unsupported Bambu cloud operation: ${(unhandled as { operation: string }).operation}`)
    }
  }
}

async function fetchCsrfToken(webHost: string, signal?: AbortSignal): Promise<{ token: string; cookie: string } | null> {
  try {
    const url = assertSafeOutboundUrl(`https://${webHost}/api/csrf`, { allowedHosts: BAMBU_CLOUD_ALLOWED_HOSTS })
    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' }
    }, signal)
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const cookies = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter((value): value is string => Boolean(value))
    for (const raw of cookies) {
      const [pair] = raw.split(';')
      const separator = pair?.indexOf('=') ?? -1
      if (!pair || separator < 0) continue
      if (pair.slice(0, separator).trim() !== 'bbl_csrf_token') continue
      const token = pair.slice(separator + 1).trim()
      if (token) return { token, cookie: `bbl_csrf_token=${token}` }
    }
    return null
  } catch (error) {
    // Same reason as the bridge relay's copy: the caller reports "could not obtain a
    // security token", which is right for the user but leaves the cause unrecorded.
    console.warn(`[bambu-cloud-sync] could not fetch the CSRF token: ${(error as Error).message}`)
    return null
  }
}

async function execute(
  rawUrl: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  extraHeaders: Record<string, string>,
  signal?: AbortSignal
): Promise<BambuCloudResponse> {
  const url = assertSafeOutboundUrl(rawUrl, { allowedHosts: BAMBU_CLOUD_ALLOWED_HOSTS })
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/json', ...extraHeaders }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const response = await fetchWithTimeout(url.toString(), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }, signal)

  const text = await response.text()
  if (!text.trim()) return { status: response.status, body: null }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown }
  } catch {
    // Not JSON: a Cloudflare interstitial, an edge error page, or a plain-text validation
    // message. Keep a bounded excerpt so the caller can say what actually came back
    // instead of reporting a generic parse failure. Mirrors the bridge relay's handling
    // in `apps/bridge/src/bambu-cloud-relay.ts`.
    return { status: response.status, body: null, bodyText: text.slice(0, BAMBU_CLOUD_BODY_TEXT_LIMIT) }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
}
