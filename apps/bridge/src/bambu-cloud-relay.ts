/**
 * Bambu Lab cloud relay: performs one named cloud call from the bridge's own network.
 *
 * Owns the HTTP half of the `bambu.cloud.request` RPC: URL construction, the client
 * identity we present to Bambu, and the TOTP CSRF dance. It owns no policy: it does
 * not decide whether a credential is dead, whether to retry, or what a status means.
 * The API plugin (`apps/api/src/plugins/bambu-cloud-sync/`) owns all of that, because
 * the bridge deploys separately and lags, so any rule kept here would need a bridge
 * rollout to fix. This module hands back the raw status and body, plus the access token
 * Bambu sometimes places only in a response cookie. Extracting that cookie is transport
 * normalization; the API still decides whether the response succeeded.
 *
 * Why the bridge at all: on a multi-workspace deployment every workspace would
 * otherwise reach Bambu from one shared egress IP, and Bambu's edge rate-limits and
 * challenges per-IP, one busy workspace would degrade the feature for all of them.
 * Relaying puts a household's traffic on that household's own connection.
 *
 * **Secrets.** The access token and (during sign-in only) the account password pass
 * through here. Neither is persisted, and neither may be logged: `describeOperation`
 * exists so failures can be traced by operation name without the payload.
 */
import {
  BAMBU_CLOUD_BODY_TEXT_LIMIT,
  BAMBU_MAKERWORLD_CLIENT_HEADERS,
  BAMBU_SLICER_API_VERSION,
  bambuCloudHosts,
  type BridgeBambuCloudRequestParams,
  type BridgeBambuCloudRequestResult
} from '@printstream/shared'

/**
 * How we introduce ourselves to Bambu Lab. Honest identification, with a URL that
 * makes the source unambiguous: this is an unofficial client and must never present
 * itself as BambuStudio. (Bambu's May 2026 post on cloud access called out a fork for
 * exactly that.) Our neutral `version` query parameter is the other half of the same
 * posture: see `BAMBU_SLICER_API_VERSION`.
 */
const USER_AGENT = 'PrintStream/1.0 (+https://printstream.app)'

/** Bambu's edge can be slow under challenge; well below the RPC timeout above us. */
const REQUEST_TIMEOUT_MS = 20_000

interface PreparedRequest {
  url: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  /** True when the call must not carry the bearer token (the sign-in endpoints). */
  anonymous?: boolean
  headers?: Record<string, string>
}

type CsrfTokenResult =
  | { ok: true; token: string; cookie: string }
  | { ok: false; response: BridgeBambuCloudRequestResult }

export async function performBambuCloudRequest(
  params: BridgeBambuCloudRequestParams,
  signal?: AbortSignal
): Promise<BridgeBambuCloudRequestResult> {
  const hosts = bambuCloudHosts(params.region)

  // TOTP is the one operation that is not a plain call: it lives on the web origin,
  // which is CSRF-protected by double submit, so it needs a token fetched first.
  if (params.request.operation === 'verifyTotp') {
    return await performTotpVerification(hosts.web, params.request.tfaKey, params.request.code, signal)
  }

  const prepared = prepareRequest(hosts, { ...params, request: params.request })
  return await executeRequest(prepared, params.accessToken, prepared.headers ?? {}, signal)
}

/**
 * Everything except `verifyTotp`, which `performBambuCloudRequest` handles before it
 * gets here (it targets the web origin and needs a CSRF token, so it is not a plain
 * call). Stating that in the type rather than leaving it to a comment is what lets the
 * switch below assert exhaustiveness.
 */
type PlainBambuCloudRequestParams = BridgeBambuCloudRequestParams & {
  request: Exclude<BridgeBambuCloudRequestParams['request'], { operation: 'verifyTotp' }>
}

function prepareRequest(hosts: ReturnType<typeof bambuCloudHosts>, params: PlainBambuCloudRequestParams): PreparedRequest {
  const apiHost = hosts.api
  const settingBase = `https://${apiHost}/v1/iot-service/api/slicer/setting`
  // Bambu rejects a `slicer/setting` call with no `version` (HTTP 400) and one whose
  // format is not XX.YY.ZZ.WW (HTTP 422), on every verb including DELETE.
  const versionQuery = `?version=${encodeURIComponent(BAMBU_SLICER_API_VERSION)}`
  const loginUrl = `https://${apiHost}/v1/user-service/user/login`

  switch (params.request.operation) {
    case 'login':
      return {
        url: loginUrl,
        method: 'POST',
        anonymous: true,
        body: { account: params.request.account, password: params.request.password }
      }
    case 'verifyEmailCode':
      // Same endpoint as login: sending `code` instead of `password` is what makes it
      // the second leg rather than a fresh attempt.
      return {
        url: loginUrl,
        method: 'POST',
        anonymous: true,
        body: { account: params.request.account, code: params.request.code }
      }
    case 'listSettings':
      return { url: `${settingBase}${versionQuery}`, method: 'GET' }
    case 'getSetting':
      return { url: `${settingBase}/${encodeURIComponent(params.request.settingId)}${versionQuery}`, method: 'GET' }
    case 'createSetting':
      return { url: `${settingBase}${versionQuery}`, method: 'POST', body: params.request.payload }
    case 'patchSetting':
      // PATCH, not PUT: PUT answers 405 here, which is why an update is widely
      // (and wrongly) believed to require delete-then-recreate.
      return {
        url: `${settingBase}/${encodeURIComponent(params.request.settingId)}${versionQuery}`,
        method: 'PATCH',
        body: params.request.payload
      }
    case 'deleteSetting':
      return { url: `${settingBase}/${encodeURIComponent(params.request.settingId)}${versionQuery}`, method: 'DELETE' }
    case 'getMakerWorldDesign':
      return {
        url: `https://${hosts.makerWorld}/api/v1/design-service/design/${params.request.designId}`,
        method: 'GET',
        headers: BAMBU_MAKERWORLD_CLIENT_HEADERS
      }
    case 'getMakerWorldDownloadTarget':
      return {
        url: `https://${hosts.makerWorld}/api/v1/design-service/instance/${params.request.instanceId}/f3mf`,
        method: 'GET',
        headers: BAMBU_MAKERWORLD_CLIENT_HEADERS
      }
    case 'refreshToken':
      // Trades the refresh token for a new credential. Anonymous: the point is that the
      // bearer token it would carry is the expired one.
      return {
        url: `https://${apiHost}/v1/user-service/user/refreshtoken`,
        method: 'POST',
        body: { refreshToken: params.request.refreshToken },
        anonymous: true
      }
    default: {
      // Compile-time exhaustiveness: this file and the API's `transport.ts` each switch
      // over the same operation union in two different processes with independent deploy
      // cadences, so adding an operation to the shared schema without updating BOTH would
      // otherwise only surface at runtime, on whichever path happened to be taken. This
      // makes the omission a typecheck failure instead.
      const unhandled: never = params.request
      void unhandled
      throw new Error(`Unsupported Bambu cloud operation: ${describeOperation(params)}`)
    }
  }
}

/**
 * TOTP sign-in, which does not go where everything else goes.
 *
 * The code is verified at `bambulab.com/api/sign-in/tfa`, the WEB origin, not the API
 * host, and that origin requires the cookie session established by `GET /api/csrf`
 * plus double-submit CSRF: without the `bbl_csrf_token` cookie the request is refused
 * before the code is read, and with the cookie but no matching header it is refused as
 * `missing_header`. A CSRF rejection therefore looks nothing like a wrong code and
 * must not be reported as one; the API side distinguishes them from the body.
 */
async function performTotpVerification(
  webHost: string,
  tfaKey: string,
  code: string,
  signal?: AbortSignal
): Promise<BridgeBambuCloudRequestResult> {
  const csrf = await fetchCsrfToken(webHost, signal)
  if (!csrf.ok) return csrf.response

  return await executeRequest(
    { url: `https://${webHost}/api/sign-in/tfa`, method: 'POST', anonymous: true, body: { tfaKey, tfaCode: code } },
    undefined,
    { 'x-bbl-csrf-token': csrf.token, cookie: csrf.cookie },
    signal
  )
}

/**
 * Establishes Bambu's web session and returns its cookie jar plus CSRF header value.
 *
 * Fetched per verification rather than cached: a stale cookie that disagrees with the
 * header it is echoed in fails the same way a missing one does, and this runs at most
 * once per sign-in.
 */
async function fetchCsrfToken(webHost: string, signal?: AbortSignal): Promise<CsrfTokenResult> {
  try {
    const response = await fetchWithTimeout(`https://${webHost}/api/csrf`, {
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

    // The website's TOTP handler needs the complete session established by the
    // CSRF response. Sending only bbl_csrf_token reaches the handler but yields
    // "Login failed" for valid codes.
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    return { ok: true, token, cookie }
  } catch (error) {
    // The response tells the user their code was not the problem. Log the safe transport
    // cause so a failing TOTP sign-in is diagnosable without reproducing it.
    console.warn(`[bambu-cloud-relay] could not fetch the CSRF token: ${(error as Error).message}`)
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

function readSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const single = response.headers.get('set-cookie')
  return single ? [single] : []
}

/** Reads the latest non-empty value of every response cookie without logging it. */
function readResponseCookies(response: Response): Map<string, string> {
  const cookies = new Map<string, string>()

  for (const raw of readSetCookies(response)) {
    const [pair] = raw.split(';')
    const separator = pair?.indexOf('=') ?? -1
    if (!pair || separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (name && value) cookies.set(name, value)
  }

  return cookies
}

async function executeRequest(
  prepared: PreparedRequest,
  accessToken: string | undefined,
  extraHeaders: Record<string, string>,
  signal?: AbortSignal
): Promise<BridgeBambuCloudRequestResult> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: 'application/json',
    ...extraHeaders
  }
  if (prepared.body !== undefined) headers['content-type'] = 'application/json'
  if (accessToken && !prepared.anonymous) headers.authorization = `Bearer ${accessToken}`

  const response = await fetchWithTimeout(prepared.url, {
    method: prepared.method,
    headers,
    ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) })
  }, signal)

  return await readBambuCloudResponse(response)
}

/** Converts one fetch response into the bounded RPC response contract. */
async function readBambuCloudResponse(response: Response): Promise<BridgeBambuCloudRequestResult> {
  // A successful authenticator verification may place the credential only in
  // `Set-Cookie: token=...`. Return that one secret to the authenticated API and
  // discard the rest of the website session.
  const tokenCookie = readResponseCookies(response).get('token')
  const text = await response.text()
  if (!text.trim()) return { status: response.status, body: null, ...(tokenCookie ? { tokenCookie } : {}) }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown, ...(tokenCookie ? { tokenCookie } : {}) }
  } catch {
    // Not JSON: a Cloudflare interstitial, an edge error page, or a plain-text
    // validation message. Keep a bounded excerpt so it is diagnosable from a log
    // without replaying the request; the API decides what it means.
    return {
      status: response.status,
      body: null,
      bodyText: text.slice(0, BAMBU_CLOUD_BODY_TEXT_LIMIT),
      ...(tokenCookie ? { tokenCookie } : {})
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  return await fetch(url, { ...init, signal: composed })
}

/** Operation name only: the params carry the account password and the access token. */
export function describeOperation(params: BridgeBambuCloudRequestParams): string {
  return `${params.request.operation} (${params.region})`
}
