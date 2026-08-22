/**
 * The typed Bambu cloud operations, and the one place that decides what a response
 * MEANS.
 *
 * Everything below the transport hands back a raw status and body on purpose (see
 * `transport.ts`), so this module owns the whole interpretation layer: which failures
 * are a dead credential, which are Bambu's edge refusing us, which are the account's
 * preset quota, and which are ordinary errors. Keeping that here means a change in
 * Bambu's error shapes is an API-side fix, with no bridge rollout.
 *
 * **Failure posture.** Every function throws `BambuCloudError` with a `kind`, and no
 * caller may treat an unclassified failure as "the credential is dead" — a stray edge
 * 401 or a Cloudflare challenge must leave the stored credential alone, or a single
 * blip signs the workspace out of a session that still works.
 */
import { ZodError } from 'zod'
import {
  bambuCloudSettingDetailSchema,
  bambuCloudSettingListSchema,
  isBambuCloudChallengeResponse,
  isBambuCloudExpiryResponse,
  isBambuCloudQuotaResponse,
  type BambuCloudRegion,
  type BambuCloudResponse,
  type BambuCloudSettingDetail,
  type BambuCloudSettingList,
  type BambuCloudSettingPayload
} from '@printstream/shared'
import { HttpError } from '../../lib/http-error.js'
import { performBambuCloudCall, type BambuCloudCallRoute } from './transport.js'
import type { PluginLogger } from '../../plugin/types.js'

export type BambuCloudFailureKind =
  /** Bambu's signed "Please login." — the stored credential is genuinely dead. */
  | 'expired'
  /** Cloudflare stood in front of the API. Not an auth problem and not ours to fix. */
  | 'challenge'
  /** The account is at its cloud preset limit; creating more will keep failing. */
  | 'quota'
  /** Anything else Bambu said, including an unsigned 401. */
  | 'http'

/**
 * What WE answer a browser with for a given upstream failure.
 *
 * Deliberately never 401: that status means "your PrintStream session is bad", and the
 * thing that is actually bad here is the workspace's stored BAMBU credential. Saying
 * 401 would point the user at the wrong sign-in entirely.
 */
function httpStatusForFailure(kind: BambuCloudFailureKind, upstreamStatus: number): number {
  switch (kind) {
    // The user has to act (reconnect the account, or free up cloud presets), and
    // nothing about retrying the same request will help.
    case 'expired':
    case 'quota':
      return 409
    // Bambu's edge is refusing us for now. Temporary, and not the user's doing.
    case 'challenge':
      return 503
    case 'http':
      // Bambu rejected what the user supplied (a wrong password or verification code)
      // — that is a bad request, not a server fault. Anything Bambu failed on its own
      // (5xx, or a transport failure we recorded as status 0) is an upstream problem.
      return upstreamStatus === 0 || upstreamStatus >= 500 ? 502 : 400
  }
}

/**
 * Extends `HttpError` so the API's error middleware surfaces the MESSAGE rather than
 * replacing it. This is not a detail: every message this module composes ("Incorrect
 * account or password.", the Cloudflare notice, the quota notice, "reconnect the
 * account") is written to be read by a user, and a plain `Error` reaching the handler
 * is answered as a bare 500 "Internal server error" with the real text left in the
 * server log. That shipped once, and made a wrong password indistinguishable from a
 * crash.
 */
export class BambuCloudError extends HttpError {
  readonly kind: BambuCloudFailureKind
  /** Bambu's own status, as distinct from the `statusCode` we answer with. */
  readonly upstreamStatus: number

  constructor(message: string, kind: BambuCloudFailureKind, upstreamStatus: number) {
    super(httpStatusForFailure(kind, upstreamStatus), message)
    this.name = 'BambuCloudError'
    this.kind = kind
    this.upstreamStatus = upstreamStatus
  }
}

export interface BambuCloudSession {
  region: BambuCloudRegion
  accessToken: string
}

/**
 * The credential Bambu issues, in full.
 *
 * All four fields matter and none may be dropped. The access token is opaque and
 * short-lived relative to the refresh token, so keeping only the access token means the
 * connection silently dies at an unpredictable moment and the user has to redo password
 * plus 2FA. `expiresIn`/`refreshExpiresIn` are SECONDS from now, per BambuStudio's own
 * `TokenResp` (`src/slic3r/GUI/HttpServer.cpp`) — stored as absolute instants, because a
 * relative lifetime is meaningless once written to disk.
 */
export interface BambuCloudCredential {
  accessToken: string
  refreshToken: string | null
  /** Absolute ISO instants, derived from Bambu's relative seconds. Null when unstated. */
  expiresAt: string | null
  refreshExpiresAt: string | null
}

/**
 * Reads the credential out of a token response, tolerating a missing field rather than
 * failing: Bambu is an unofficial API and an absent `expiresIn` should degrade to "we do
 * not know when this lapses", not to a broken sign-in.
 */
export function readBambuCloudCredential(body: Record<string, unknown>, accessToken: string): BambuCloudCredential {
  // ONE clock read for every field: both lifetimes are measured from the same issue
  // instant, so calling `Date.now()` per field lets a millisecond tick land between them
  // and makes the two expiries disagree about when the credential was issued.
  const issuedAtMs = Date.now()
  const seconds = (value: unknown): string | null => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? new Date(issuedAtMs + value * 1000).toISOString()
      : null
  )
  return {
    accessToken,
    refreshToken: typeof body.refreshToken === 'string' && body.refreshToken ? body.refreshToken : null,
    expiresAt: seconds(body.expiresIn),
    refreshExpiresAt: seconds(body.refreshExpiresIn)
  }
}

/**
 * What the first leg of a sign-in produced. Bambu almost always demands a second
 * factor, so `authenticated` straight from `login` is the rare path.
 */
export type BambuCloudLoginResult =
  | { status: 'authenticated'; credential: BambuCloudCredential }
  | { status: 'needsEmailCode' }
  | { status: 'needsTotp'; tfaKey: string }

export interface CallContext {
  workspaceId: string
  logger: PluginLogger
  signal?: AbortSignal
  /**
   * Overrides how the call is made. Production leaves it unset and gets the
   * bridge-preferred transport; the sync tests supply a scripted cloud here so they
   * exercise the real engine, client and bookkeeping without reaching the network.
   */
  call?: typeof performBambuCloudCall
}

/**
 * One call, through the injected transport when a caller supplied one.
 *
 * A transport-level throw — DNS failure, connection refused, the 20s timeout firing —
 * is converted here rather than left to propagate. Left raw it is not an `HttpError`,
 * so the API's error middleware answers a bare 500 "Internal server error" and the
 * actual cause only reaches the server log; classifying it keeps every failure out of
 * this module shaped the same way, which is what the rest of the plugin relies on.
 */
async function runCall(
  context: CallContext,
  request: Parameters<typeof performBambuCloudCall>[1]
): ReturnType<typeof performBambuCloudCall> {
  try {
    return await (context.call ?? performBambuCloudCall)(context.workspaceId, request, context.logger, context.signal)
  } catch (error) {
    if (error instanceof BambuCloudError) throw error
    const detail = error instanceof Error ? error.message : 'unknown error'
    // Upstream status 0 — there was no response at all to read one from.
    throw new BambuCloudError(`Could not reach Bambu Cloud (${detail}).`, 'http', 0)
  }
}

/**
 * Parses a Bambu response body, turning a schema mismatch into a sentence.
 *
 * A raw `ZodError` message is a JSON dump of the issue list. Left to propagate it
 * becomes the text the user reads — which is exactly what happened when a detail read
 * turned out not to carry `setting_id`: fifty presets each reported a paragraph of JSON
 * instead of "Bambu Cloud returned this preset in an unexpected format". Naming the
 * offending fields keeps it diagnosable without pasting the whole dump at someone.
 */
function parseCloudBody<T>(schema: { parse: (value: unknown) => T }, body: unknown, context: string): T {
  try {
    return schema.parse(body ?? {})
  } catch (error) {
    const fields = error instanceof ZodError
      ? [...new Set(error.issues.map((issue) => issue.path.join('.')).filter(Boolean))].join(', ')
      : ''
    throw new BambuCloudError(
      `${context}: Bambu Cloud returned an unexpected response format${fields ? ` (unreadable: ${fields})` : ''}.`,
      'http',
      502
    )
  }
}

/** Starts a sign-in. The password is used for this call only and is never stored. */
export async function beginBambuCloudLogin(
  context: CallContext,
  region: BambuCloudRegion,
  account: string,
  password: string
): Promise<BambuCloudLoginResult> {
  const { response } = await runCall(context, { region, request: { operation: 'login', account, password } })
  assertOk(response, 'Bambu Cloud sign-in failed')

  const body = asRecord(response.body)
  const loginType = typeof body.loginType === 'string' ? body.loginType : null
  const tfaKey = typeof body.tfaKey === 'string' && body.tfaKey ? body.tfaKey : null

  // An authenticator-app account is identified by `loginType: "tfa"`, but a tfaKey
  // arriving alongside any non-`verifyCode` login type means the same thing.
  if (loginType === 'tfa' || (tfaKey && loginType !== 'verifyCode')) {
    if (!tfaKey) throw new BambuCloudError('Bambu Cloud asked for an authenticator code but sent no session key.', 'http', response.status)
    return { status: 'needsTotp', tfaKey }
  }
  if (loginType === 'verifyCode') return { status: 'needsEmailCode' }
  if (typeof body.accessToken === 'string' && body.accessToken) {
    return { status: 'authenticated', credential: readBambuCloudCredential(body, body.accessToken) }
  }

  throw new BambuCloudError(readErrorMessage(body) ?? 'Bambu Cloud sign-in failed.', 'http', response.status)
}

/** Second leg for an email-code account. */
export async function verifyBambuCloudEmailCode(
  context: CallContext,
  region: BambuCloudRegion,
  account: string,
  code: string
): Promise<BambuCloudCredential> {
  const { response } = await runCall(context, { region, request: { operation: 'verifyEmailCode', account, code } })
  return readIssuedToken(response, 'Bambu Cloud rejected that verification code.')
}

/**
 * Second leg for an authenticator-app account.
 *
 * A CSRF rejection is reported as its own message: the web origin refuses the request
 * before it ever evaluates the code, so reporting it as "invalid code" sends the user
 * hunting for clock drift on a request Bambu never read.
 */
export async function verifyBambuCloudTotp(
  context: CallContext,
  region: BambuCloudRegion,
  tfaKey: string,
  code: string
): Promise<BambuCloudCredential> {
  const { response } = await runCall(context, { region, request: { operation: 'verifyTotp', tfaKey, code } })

  const body = asRecord(response.body)
  const error = typeof body.error === 'string' ? body.error : ''
  const reason = typeof body.reason === 'string' ? body.reason : ''
  if (error.toLowerCase().includes('csrf') || reason === 'missing_cookie' || reason === 'missing_header') {
    throw new BambuCloudError(
      'Bambu Cloud refused the sign-in request before checking your code (security-token error). Your code is fine — please try again.',
      'http',
      response.status
    )
  }
  if (response.status === 0) {
    throw new BambuCloudError(response.bodyText ?? 'Could not reach Bambu Cloud to verify the code.', 'http', 0)
  }
  return readIssuedToken(response, 'Bambu Cloud rejected that authenticator code.')
}

/**
 * Trades a refresh token for a fresh credential.
 *
 * The only call this plugin ever makes on a schedule, and the reason a schedule is
 * justified at all: the access token lapses on its own clock, and once it and the refresh
 * token are both gone the user has to redo password plus 2FA. Refreshing costs one call
 * per token lifetime, which is nothing like polling.
 *
 * **Status: not known to work.** `POST /v1/user-service/user/refreshtoken` is real — it
 * answers 401 where invented sibling paths answer 404 — but it returns that SAME 401 for a
 * valid refresh token as for a garbage one, with the body shape (camelCase, snake_case)
 * and a bearer header making no difference. So it is not reading the request the way this
 * assumes. Studio reaches refresh through the closed BambuNetworkEngine, and its local
 * `/refresh_token` handler carries device identity (`device`, `dev_ver`, `channel`, a
 * scramble key), which is the likely missing piece.
 *
 * Left in place because the plumbing is right and only the request shape is in question,
 * but the CALLER MUST NOT treat a failure here as expiry: the access token it would
 * discard is still valid. See `refreshWorkspaceCredentialIfDue`.
 */
export async function refreshBambuCloudCredential(
  context: CallContext,
  region: BambuCloudRegion,
  refreshToken: string
): Promise<BambuCloudCredential> {
  const { response } = await runCall(context, { region, request: { operation: 'refreshToken', refreshToken } })
  return readIssuedToken(response, 'Bambu Cloud would not renew the sign-in')
}

/**
 * Whether Bambu still accepts a stored credential.
 *
 * Three-valued on purpose: `null` means "could not tell" (Bambu unreachable, 5xx, a
 * challenge). A caller must report its last known state for `null` and never treat it
 * as a rejection — an outage would otherwise disconnect every workspace at once.
 */
export async function checkBambuCloudSession(
  context: CallContext,
  session: BambuCloudSession
): Promise<boolean | null> {
  try {
    await listBambuCloudSettings(context, session)
    return true
  } catch (error) {
    if (error instanceof BambuCloudError && error.kind === 'expired') return false
    return null
  }
}

export async function listBambuCloudSettings(
  context: CallContext,
  session: BambuCloudSession
): Promise<{ list: BambuCloudSettingList; route: BambuCloudCallRoute }> {
  const { response, route } = await runCall(context, { region: session.region, accessToken: session.accessToken, request: { operation: 'listSettings' } })
  assertOk(response, 'Could not list your Bambu Cloud presets')
  return { list: parseCloudBody(bambuCloudSettingListSchema, response.body, 'Could not list your Bambu Cloud presets'), route }
}

export async function getBambuCloudSetting(
  context: CallContext,
  session: BambuCloudSession,
  settingId: string
): Promise<BambuCloudSettingDetail> {
  const { response } = await runCall(context, { region: session.region, accessToken: session.accessToken, request: { operation: 'getSetting', settingId } })
  assertOk(response, `Could not read Bambu Cloud preset ${settingId}`)
  return parseCloudBody(bambuCloudSettingDetailSchema, response.body, `Could not read Bambu Cloud preset ${settingId}`)
}

/** Creates a cloud preset and returns its new `setting_id`. */
export async function createBambuCloudSetting(
  context: CallContext,
  session: BambuCloudSession,
  payload: BambuCloudSettingPayload
): Promise<BambuCloudSettingDetail> {
  const { response } = await runCall(context, { region: session.region, accessToken: session.accessToken, request: { operation: 'createSetting', payload } })
  assertOk(response, `Could not create "${payload.name}" in Bambu Cloud`)
  return parseCloudBody(bambuCloudSettingDetailSchema, response.body, `Could not create "${payload.name}" in Bambu Cloud`)
}

/**
 * Updates a cloud preset in place.
 *
 * PATCH, never delete-then-create: Bambu answers PUT with 405, which is why the
 * destructive workaround is common, but PATCH against the setting id is what
 * BambuStudio's own `put_setting` performs. The distinction is not cosmetic — a
 * delete-then-create whose create fails destroys the user's preset, and it re-mints
 * the `setting_id` that every device's local copy is bound to.
 */
export async function patchBambuCloudSetting(
  context: CallContext,
  session: BambuCloudSession,
  settingId: string,
  payload: BambuCloudSettingPayload
): Promise<BambuCloudSettingDetail> {
  const { response } = await runCall(context, { region: session.region, accessToken: session.accessToken, request: { operation: 'patchSetting', settingId, payload } })
  assertOk(response, `Could not update "${payload.name}" in Bambu Cloud`)
  return parseCloudBody(bambuCloudSettingDetailSchema, response.body, `Could not update "${payload.name}" in Bambu Cloud`)
}

/** Deletes a cloud preset. Idempotent upstream: deleting a missing id still answers 200. */
export async function deleteBambuCloudSetting(
  context: CallContext,
  session: BambuCloudSession,
  settingId: string
): Promise<void> {
  const { response } = await runCall(context, { region: session.region, accessToken: session.accessToken, request: { operation: 'deleteSetting', settingId } })
  assertOk(response, `Could not delete preset ${settingId} from Bambu Cloud`)
}

function readIssuedToken(response: BambuCloudResponse, failureMessage: string): BambuCloudCredential {
  assertOk(response, failureMessage)
  const body = asRecord(response.body)
  const token = typeof body.accessToken === 'string' && body.accessToken
    ? body.accessToken
    : typeof body.token === 'string' && body.token ? body.token : null
  if (!token) throw new BambuCloudError(readErrorMessage(body) ?? failureMessage, 'http', response.status)
  return readBambuCloudCredential(body, token)
}

/**
 * Turns a non-2xx into a classified `BambuCloudError`, in the order that matters:
 * challenge and quota are recognised before the generic path so they are not reported
 * as "Bambu Cloud returned 403", and expiry is checked against its signature rather
 * than the bare status.
 */
function assertOk(response: BambuCloudResponse, context: string): void {
  if (response.status >= 200 && response.status < 300) return

  if (isBambuCloudChallengeResponse(response)) {
    throw new BambuCloudError(
      'Bambu Cloud is temporarily blocking automated requests from this network (a Cloudflare protection on Bambu\'s side). Wait a few minutes and try again.',
      'challenge',
      response.status
    )
  }
  if (isBambuCloudExpiryResponse(response)) {
    throw new BambuCloudError('Your Bambu Cloud sign-in has expired. Reconnect the account to keep syncing.', 'expired', response.status)
  }
  if (isBambuCloudQuotaResponse(response)) {
    throw new BambuCloudError(
      'This Bambu Cloud account has reached its limit for stored presets. Remove some in Bambu Studio, or keep the extra presets in PrintStream only.',
      'quota',
      response.status
    )
  }

  // Bambu's own text is written for a person ("Incorrect account or password.") and is
  // more useful than anything we could add, so lead with it and drop the status noise.
  // The bare status is a fallback for when it says nothing usable — not the headline.
  const detail = readErrorMessage(asRecord(response.body)) ?? response.bodyText?.slice(0, 200)
  throw new BambuCloudError(
    detail ? `${context}: ${detail}` : `${context}: Bambu Cloud returned ${response.status}.`,
    'http',
    response.status
  )
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

function readErrorMessage(body: Record<string, unknown>): string | null {
  for (const key of ['message', 'error', 'detail']) {
    const value = body[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}
