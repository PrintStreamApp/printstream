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
 * A Cloudflare interstitial is retried exactly once after a short pause. Live account
 * connection and MakerWorld import attempts have both succeeded on the immediate next
 * try; one bounded retry hides that edge blip without turning rejection into a loop.
 *
 * Counterpart: `apps/bridge/src/bambu-cloud-relay.ts`.
 */
import {
  BAMBU_CLOUD_ALLOWED_HOSTS,
  BAMBU_CLOUD_BODY_TEXT_LIMIT,
  BAMBU_MAKERWORLD_CLIENT_HEADERS,
  BAMBU_SLICER_API_VERSION,
  bambuCloudHosts,
  bambuCloudResponseSchema,
  isBambuCloudChallengeResponse,
  isUnsupportedBridgeRpcError,
  type BambuCloudRequest,
  type BambuCloudResponse
} from '@printstream/shared'
import { setTimeout as delay } from 'node:timers/promises'
import { bridgeSessionManager } from '../../lib/bridge-session-manager.js'
import { assertSafeOutboundUrl } from '../../lib/outbound-url-guard.js'
import { rootPrisma } from '../../lib/prisma.js'
import type { PluginLogger } from '../../plugin/types.js'

/** Same honest client identity the bridge relay presents; see the note there. */
const USER_AGENT = 'PrintStream/1.0 (+https://printstream.app)'
const REQUEST_TIMEOUT_MS = 20_000
/** Generous: the relay's own HTTP timeout is 20s and the RPC has to outlive it. */
const BRIDGE_RPC_TIMEOUT_MS = 30_000
const CHALLENGE_RETRY_DELAY_MS = 1_500

interface BambuCloudCallDeps {
  /** Tests replace the pause; production waits long enough for a request-scoped challenge to clear. */
  waitBeforeChallengeRetry?: (signal?: AbortSignal) => Promise<void>
}

export type BambuCloudCallRoute = 'bridge' | 'direct'

export interface BambuCloudCallResult {
  response: BambuCloudResponse
  /** Which path served it, for the "synced via your bridge" line in the UI. */
  route: BambuCloudCallRoute
}

type CsrfTokenResult =
  | { ok: true; token: string; cookie: string }
  | { ok: false; response: BambuCloudResponse }

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
  signal?: AbortSignal,
  deps: BambuCloudCallDeps = {}
): Promise<BambuCloudCallResult> {
  const waitBeforeChallengeRetry = deps.waitBeforeChallengeRetry ?? waitForChallengeRetry
  const bridgeId = await findConnectedBridgeId(workspaceId)
  if (bridgeId) {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await bridgeSessionManager.requestRpc<unknown>(
          bridgeId,
          'bambu.cloud.request',
          request,
          { timeoutMs: BRIDGE_RPC_TIMEOUT_MS }
        )
        const response = bambuCloudResponseSchema.parse(result)
        if (attempt === 0 && shouldRetryChallenge(request, response)) {
          logger.info('Bambu cloud call hit a temporary challenge via bridge; retrying once.')
          await waitBeforeChallengeRetry(signal)
          continue
        }
        return { response, route: 'bridge' }
      }
    } catch (error) {
      const reason = isUnsupportedBridgeRpcError(error)
        ? 'the bridge is too old to relay Bambu cloud calls'
        : (error as Error).message
      logger.info(`Bambu cloud call fell back to a direct server call (${reason})`)
    }
  }

  let response = await directBambuCloudRequest(request, signal)
  if (shouldRetryChallenge(request, response)) {
    logger.info('Bambu cloud call hit a temporary challenge via direct server call; retrying once.')
    await waitBeforeChallengeRetry(signal)
    response = await directBambuCloudRequest(request, signal)
  }
  return { response, route: 'direct' }
}

/** Waits between the one permitted challenge retry and respects request cancellation. */
async function waitForChallengeRetry(signal?: AbortSignal): Promise<void> {
  await delay(CHALLENGE_RETRY_DELAY_MS, undefined, signal ? { signal } : undefined)
}

/**
 * Retries reads whenever the response classifies as a challenge. Sign-in POSTs are
 * retried only for an unmistakable Cloudflare HTML page, which proves the request
 * stopped at the edge. Preset writes and token rotation are never replayed because a
 * body-less 503 cannot prove whether Bambu applied the mutation before responding.
 */
function shouldRetryChallenge(request: BambuCloudRequest, response: BambuCloudResponse): boolean {
  if (!isBambuCloudChallengeResponse(response)) return false

  switch (request.request.operation) {
    case 'listSettings':
    case 'getSetting':
    case 'getMakerWorldDesign':
    case 'getMakerWorldDownloadTarget':
      return true
    case 'login':
    case 'verifyEmailCode':
    case 'verifyTotp':
      return /Just a moment|challenges\.cloudflare/i.test(response.bodyText ?? '')
    case 'createSetting':
    case 'patchSetting':
    case 'deleteSetting':
    case 'refreshToken':
      return false
    default: {
      const unhandled: never = request.request
      throw new Error(`Unsupported Bambu cloud operation: ${(unhandled as { operation: string }).operation}`)
    }
  }
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
    if (!csrf.ok) return csrf.response
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
    case 'getMakerWorldDesign':
      return await execute(
        `https://${hosts.makerWorld}/api/v1/design-service/design/${request.request.designId}`,
        'GET',
        undefined,
        { ...authHeaders, ...BAMBU_MAKERWORLD_CLIENT_HEADERS },
        signal
      )
    case 'getMakerWorldDownloadTarget':
      return await execute(
        `https://${hosts.makerWorld}/api/v1/design-service/instance/${request.request.instanceId}/f3mf`,
        'GET',
        undefined,
        { ...authHeaders, ...BAMBU_MAKERWORLD_CLIENT_HEADERS },
        signal
      )
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

async function fetchCsrfToken(webHost: string, signal?: AbortSignal): Promise<CsrfTokenResult> {
  try {
    const url = assertSafeOutboundUrl(`https://${webHost}/api/csrf`, { allowedHosts: BAMBU_CLOUD_ALLOWED_HOSTS })
    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' }
    }, signal)
    const cookies = readResponseCookies(response)
    const token = cookies.get('bbl_csrf_token')
    if (!token) {
      const failure = await readBambuCloudResponse(response)
      if (failure.status >= 200 && failure.status < 300) {
        return {
          ok: false,
          response: {
            status: 0,
            body: null,
            bodyText: 'Could not obtain a security token from Bambu Cloud (GET /api/csrf returned no bbl_csrf_token).'
          }
        }
      }
      return { ok: false, response: failure }
    }

    // Bambu's web login is a real cookie-backed session, not just double-submit
    // CSRF. Sending only bbl_csrf_token reaches the TOTP handler but it answers
    // "Login failed" even for a valid code. Preserve every cookie minted by the
    // CSRF response, while still echoing bbl_csrf_token in the required header.
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    return { ok: true, token, cookie }
  } catch (error) {
    // The response tells the user their code was not the problem. Log the safe transport
    // cause so a failing TOTP sign-in is diagnosable without reproducing it.
    console.warn(`[bambu-cloud-sync] could not fetch the CSRF token: ${(error as Error).message}`)
    return {
      ok: false,
      response: {
        status: 0,
        body: null,
        bodyText: `Could not obtain a security token from Bambu Cloud (${(error as Error).message}).`
      }
    }
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

  return await readBambuCloudResponse(response)
}

/** Converts one fetch response into the bounded cross-process response contract. */
async function readBambuCloudResponse(response: Response): Promise<BambuCloudResponse> {
  // The TOTP web endpoint sometimes returns the credential only as `Set-Cookie:
  // token=...`, with no token in its JSON body. Forward only that cookie's value,
  // never the rest of the web session.
  const tokenCookie = readResponseCookies(response).get('token')
  const text = await response.text()
  if (!text.trim()) return { status: response.status, body: null, ...(tokenCookie ? { tokenCookie } : {}) }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown, ...(tokenCookie ? { tokenCookie } : {}) }
  } catch {
    // Not JSON: a Cloudflare interstitial, an edge error page, or a plain-text validation
    // message. Keep a bounded excerpt so the caller can say what actually came back
    // instead of reporting a generic parse failure. Mirrors the bridge relay's handling
    // in `apps/bridge/src/bambu-cloud-relay.ts`.
    return {
      status: response.status,
      body: null,
      bodyText: text.slice(0, BAMBU_CLOUD_BODY_TEXT_LIMIT),
      ...(tokenCookie ? { tokenCookie } : {})
    }
  }
}

/** Reads the latest non-empty value of every response cookie without logging it. */
function readResponseCookies(response: Response): Map<string, string> {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const setCookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter((value): value is string => Boolean(value))
  const cookies = new Map<string, string>()

  for (const raw of setCookies) {
    const [pair] = raw.split(';')
    const separator = pair?.indexOf('=') ?? -1
    if (!pair || separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (name && value) cookies.set(name, value)
  }

  return cookies
}

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
}
