/**
 * MakerWorld model downloads, as the workspace's connected Bambu Lab user.
 *
 * Owns the three-call chain that turns a pasted model page URL into bytes:
 *
 *   1. `GET design-service/design/{designId}`            -> instances + defaultInstanceId
 *   2. `GET design-service/instance/{instanceId}/f3mf`   -> { name, url }
 *   3. `GET <url>`                                        -> the .3mf (signed, ~5 min, NO auth)
 *
 * Contract callers rely on: steps 1-2 are authenticated with the Bambu Cloud ACCESS
 * TOKEN as a bearer. That is not an assumption: MakerWorld accepts the same token
 * `api.bambulab.com` issues, and rejects it without the `Bearer` scheme (403,
 * "Please log in to download models"). Step 3's URL is pre-signed (`at`/`exp` query
 * params) and must be fetched WITHOUT the Authorization header.
 *
 * Why this exists at all: MakerWorld model pages expose no stable direct-download
 * URL, so the alternative is the companion Chrome extension replaying the same call
 * from the user's logged-in browser. Doing it here means the feature works with no
 * extension installed, at the cost of every member's download running under the one
 * account the workspace connected, which is why the caller gates on an explicit
 * opt-in and the UI names the account.
 *
 * Deliberately NOT here: which workspace may do this, and whether they opted in.
 * This module takes a credential it is handed and makes the calls.
 *
 * Known follow-up: `bambu-cloud-sync` routes its Bambu traffic through the BRIDGE
 * when one is connected, specifically so a multi-workspace cloud deployment does not
 * hit Bambu from one shared IP. These calls go direct from the API. Relaying them
 * would need new named operations on the bridge protocol (the relay takes named
 * operations, never URLs, so it cannot become an SSRF proxy), and the bridge deploys
 * separately, so a lagging bridge would have to fall back here anyway.
 */
import { assertSafeOutboundUrl } from '../../lib/outbound-url-guard.js'
import { badRequest, HttpError } from '../../lib/http-error.js'
import type { BambuAccountCredential } from '../../lib/bambu-account-registry.js'

/** Per-region MakerWorld API origin, mirroring BambuStudio's `get_model_http_url`. */
const MAKERWORLD_ORIGINS: Record<BambuAccountCredential['region'], string> = {
  global: 'https://makerworld.com',
  china: 'https://makerworld.com.cn'
}

/**
 * Hosts the signed download URL is allowed to point at. MakerWorld hands back a
 * `makerworld.bblmw.com` CDN link today; pinning to the Bambu CDN + MakerWorld
 * itself keeps a compromised or unexpected response from turning this into an
 * SSRF primitive, since we fetch whatever URL it names.
 */
const MAKERWORLD_FILE_HOSTS = ['bblmw.com', 'makerworld.com', 'makerworld.com.cn'] as const

/**
 * Client headers the MakerWorld web app sends. Mirrored because the API varies its
 * behaviour by client; they are not a credential and carry nothing about the user.
 */
const MAKERWORLD_CLIENT_HEADERS = {
  'X-BBL-Client-Type': 'web',
  'X-BBL-Client-Version': '00.00.00.01',
  'X-BBL-App-Source': 'makerworld',
  'X-BBL-Client-Name': 'MakerWorld'
} as const

const MAKERWORLD_TIMEOUT_MS = 20_000

export interface MakerWorldProfile {
  instanceId: number
  title: string | null
}

export interface MakerWorldDesign {
  designId: number
  title: string | null
  defaultInstanceId: number | null
  instances: MakerWorldProfile[]
}

export interface MakerWorldDownloadTarget {
  /** File name MakerWorld reports for the profile, e.g. `widget.3mf`. */
  fileName: string
  /** Pre-signed, short-lived URL. Fetch WITHOUT the Authorization header. */
  downloadUrl: string
}

export interface MakerWorldFetchDeps {
  fetchImpl?: typeof fetch
}

/** Reads a design's print profiles so a caller can pick one (or take the default). */
export async function fetchMakerWorldDesign(input: {
  designId: number
  credential: BambuAccountCredential
  deps?: MakerWorldFetchDeps
}): Promise<MakerWorldDesign> {
  const body = await makerWorldApiGet({
    path: `/api/v1/design-service/design/${input.designId}`,
    credential: input.credential,
    deps: input.deps
  })

  const instances = Array.isArray(body.instances)
    ? body.instances
      .map((entry: unknown) => {
        const record = entry as { id?: unknown; title?: unknown }
        const instanceId = typeof record?.id === 'number' ? record.id : null
        if (instanceId == null || !Number.isSafeInteger(instanceId)) return null
        return { instanceId, title: typeof record.title === 'string' ? record.title : null }
      })
      .filter((entry: MakerWorldProfile | null): entry is MakerWorldProfile => entry != null)
    : []

  return {
    designId: input.designId,
    title: typeof body.title === 'string' ? body.title : null,
    defaultInstanceId: typeof body.defaultInstanceId === 'number' ? body.defaultInstanceId : null,
    instances
  }
}

/** Exchanges a print profile for its short-lived signed download URL. */
export async function fetchMakerWorldDownloadTarget(input: {
  instanceId: number
  credential: BambuAccountCredential
  deps?: MakerWorldFetchDeps
}): Promise<MakerWorldDownloadTarget> {
  const body = await makerWorldApiGet({
    path: `/api/v1/design-service/instance/${input.instanceId}/f3mf`,
    credential: input.credential,
    deps: input.deps
  })

  if (typeof body.url !== 'string' || body.url.length === 0) {
    throw new HttpError(502, 'MakerWorld did not return a downloadable file for that profile.')
  }
  // The response names the URL we are about to fetch, so pin it rather than trusting it.
  assertSafeOutboundUrl(body.url, { allowedHosts: MAKERWORLD_FILE_HOSTS })

  const reportedName = typeof body.name === 'string' ? body.name.trim() : ''
  return {
    fileName: reportedName.length > 0 ? reportedName : `makerworld-${input.instanceId}.3mf`,
    downloadUrl: body.url
  }
}

/**
 * Resolves a model reference all the way to a download target, taking the design's
 * default profile when the URL did not name one.
 */
export async function resolveMakerWorldDownload(input: {
  designId: number
  instanceId: number | null
  credential: BambuAccountCredential
  deps?: MakerWorldFetchDeps
}): Promise<MakerWorldDownloadTarget> {
  let instanceId = input.instanceId
  if (instanceId == null) {
    const design = await fetchMakerWorldDesign(input)
    instanceId = design.defaultInstanceId ?? design.instances[0]?.instanceId ?? null
    if (instanceId == null) {
      throw badRequest('That MakerWorld model has no downloadable print profile.')
    }
  }
  return await fetchMakerWorldDownloadTarget({ instanceId, credential: input.credential, deps: input.deps })
}

async function makerWorldApiGet(input: {
  path: string
  credential: BambuAccountCredential
  deps?: MakerWorldFetchDeps
}): Promise<Record<string, unknown>> {
  const fetchImpl = input.deps?.fetchImpl ?? fetch
  const url = `${MAKERWORLD_ORIGINS[input.credential.region]}${input.path}`
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.credential.accessToken}`,
        ...MAKERWORLD_CLIENT_HEADERS
      },
      signal: AbortSignal.timeout(MAKERWORLD_TIMEOUT_MS)
    })
  } catch (error) {
    throw new HttpError(502, `Could not reach MakerWorld: ${(error as Error).message}`)
  }

  if (!response.ok) {
    throw translateMakerWorldError(response.status, await readErrorMessage(response))
  }

  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    throw new HttpError(502, 'MakerWorld returned a response PrintStream could not read.')
  }
}

/**
 * Maps MakerWorld's failures onto something the user can act on.
 *
 * The distinction that matters: 401/403 means the stored Bambu credential is the
 * problem (reconnect), while 418 is the anti-bot challenge, which only clears by the
 * user visiting MakerWorld themselves, no amount of retrying here helps, so say so
 * rather than surfacing a bare status. Mirrors the guidance the browser helper shows
 * (`errorGuidance.ts`), so the two paths tell the user the same story.
 */
function translateMakerWorldError(status: number, message: string | null): HttpError {
  if (status === 401 || status === 403) {
    return new HttpError(502, message?.trim()
      ? `MakerWorld rejected the connected Bambu Lab account: ${message}`
      : 'MakerWorld rejected the connected Bambu Lab account. Reconnect it in the Bambu Cloud settings.')
  }
  if (status === 418 || (message != null && /captcha|robot/i.test(message))) {
    return new HttpError(502, 'MakerWorld blocked the download with an anti-bot challenge. Open the model on MakerWorld, download it there once to clear the challenge, then try again.')
  }
  if (status === 404) {
    return new HttpError(404, 'That MakerWorld model could not be found. It may be private or removed.')
  }
  return new HttpError(502, message?.trim() ? `MakerWorld responded: ${message}` : `MakerWorld responded ${status}.`)
}

async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = await response.json() as { error?: unknown; message?: unknown }
    if (typeof body?.error === 'string') return body.error
    if (typeof body?.message === 'string') return body.message
  } catch {
    // A non-JSON error body tells us nothing useful; the status carries the meaning.
  }
  return null
}
