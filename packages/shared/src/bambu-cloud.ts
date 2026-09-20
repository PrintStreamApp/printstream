/**
 * Bambu Lab cloud slicer-preset wire contract.
 *
 * Owns the shapes of Bambu's `slicer/setting` API and the sync arithmetic built on
 * them, shared by the two apps that speak it: the `bambu-cloud-sync` API plugin
 * (which owns the sync) and `apps/bridge/src/bambu-cloud-relay.ts` (which makes the
 * calls on the workspace's own network when a bridge is available).
 *
 * **This is an unofficial API.** Nothing here is published or guaranteed by Bambu
 * Lab; every shape was read off BambuStudio's own source, the reverse-engineered
 * network-plugin research at `ClusterM/open-bamboo-networking`, or a live capture.
 * So every field is optional-by-default and every consumer must fail soft, a
 * contract change must degrade to "sync unavailable", never wedge the preset
 * manager.
 *
 * Two invariants the whole feature rests on:
 *
 * 1. **A preset is identified by its cloud `setting_id`, never its name.** (Studio
 *    itself matches locally by name, which is why renaming a preset in Studio forks
 *    it; we key on the id so a rename stays one preset.)
 * 2. **Timestamps are only ever compared server-clock to server-clock.** `update_time`
 *    is Bambu's clock. A workspace's own clock never enters a comparison with it:
 *    local edits are detected by comparing our stored `updatedAt` against the copy we
 *    recorded at last sync, both ours. See `shouldPullFromCloud`.
 */
import { z } from 'zod'
import type { SlicingPresetKind } from './slicing.js'

/**
 * Bambu runs two independent clouds with separate accounts and hosts. A credential
 * issued by one is meaningless to the other, so the region is part of the stored
 * credential rather than a global setting.
 */
export const bambuCloudRegionSchema = z.enum(['global', 'china'])
export type BambuCloudRegion = z.infer<typeof bambuCloudRegionSchema>

interface BambuCloudHosts {
  /** Host serving `/v1/...`: where every preset call goes. */
  readonly api: string
  /**
   * The web origin. Only TOTP sign-in lives here (`/api/sign-in/tfa`), and it is
   * CSRF-protected where the API host is not.
   */
  readonly web: string
}

const BAMBU_CLOUD_HOSTS: Record<BambuCloudRegion, BambuCloudHosts> = {
  global: { api: 'api.bambulab.com', web: 'bambulab.com' },
  china: { api: 'api.bambulab.cn', web: 'bambulab.cn' }
}

export function bambuCloudHosts(region: BambuCloudRegion): BambuCloudHosts {
  return BAMBU_CLOUD_HOSTS[region]
}

/** Every Bambu host this feature is allowed to reach, for the outbound URL guard. */
export const BAMBU_CLOUD_ALLOWED_HOSTS: readonly string[] = Object.values(BAMBU_CLOUD_HOSTS)
  .flatMap((hosts) => [hosts.api, hosts.web])

/**
 * The `version` query parameter every `slicer/setting` call requires.
 *
 * The API rejects a missing one with HTTP 400 (`field 'version' is not set`) and a
 * non-`XX.YY.ZZ.WW` one with HTTP 422, but does NOT check it against a real release
 * manifest. So this is a deliberately neutral placeholder: claiming a specific
 * BambuStudio build number would be impersonating a client we are not. Who we are
 * belongs in the User-Agent, honestly.
 */
export const BAMBU_SLICER_API_VERSION = '1.0.0.0'

/**
 * Bambu's name for each preset kind, which is not ours: it calls a process preset
 * `print` and a machine preset `printer`. The mapping is the wire boundary, inside
 * PrintStream a preset is always `machine` / `process` / `filament`.
 */
export const bambuCloudPresetTypeSchema = z.enum(['print', 'printer', 'filament'])
export type BambuCloudPresetType = z.infer<typeof bambuCloudPresetTypeSchema>

const CLOUD_TYPE_TO_PRESET_KIND: Record<BambuCloudPresetType, SlicingPresetKind> = {
  print: 'process',
  printer: 'machine',
  filament: 'filament'
}

const PRESET_KIND_TO_CLOUD_TYPE: Record<SlicingPresetKind, BambuCloudPresetType> = {
  process: 'print',
  machine: 'printer',
  filament: 'filament'
}

export function presetKindFromBambuCloudType(type: BambuCloudPresetType): SlicingPresetKind {
  return CLOUD_TYPE_TO_PRESET_KIND[type]
}

export function bambuCloudTypeFromPresetKind(kind: SlicingPresetKind): BambuCloudPresetType {
  return PRESET_KIND_TO_CLOUD_TYPE[kind]
}

/**
 * One entry in the listing. Metadata only: the preset's actual settings need a
 * per-id detail fetch, which is why a sync costs 1 + N round-trips.
 *
 * `.passthrough()` on purpose: the listing carries fields we do not model, and an
 * unofficial API will grow more. Stripping them would make a future field invisible
 * to a debugger reading a logged payload.
 */
export const bambuCloudSettingSummarySchema = z.object({
  setting_id: z.string().min(1),
  name: z.string().optional(),
  /** Bambu's clock, `"YYYY-MM-DD HH:MM:SS"` UTC. Parse with `parseBambuCloudUpdateTime`. */
  update_time: z.string().nullish(),
  /** Cloud id of the preset this one inherits from; empty/null for a custom root. */
  base_id: z.string().nullish(),
  filament_id: z.string().nullish(),
  user_id: z.string().nullish(),
  version: z.string().nullish(),
  nickname: z.string().nullish()
}).passthrough()

export type BambuCloudSettingSummary = z.infer<typeof bambuCloudSettingSummarySchema>

/**
 * Per-type buckets in the listing. `private` is the user's own presets; `public` is
 * Bambu's bundled catalogue, the same hundreds of entries for every account, which
 * we never import (they are the slicer image's system presets already).
 */
const bambuCloudSettingBucketSchema = z.object({
  private: z.array(bambuCloudSettingSummarySchema).nullish(),
  public: z.array(bambuCloudSettingSummarySchema).nullish()
}).partial().passthrough()

export const bambuCloudSettingListSchema = z.object({
  print: bambuCloudSettingBucketSchema.nullish(),
  printer: bambuCloudSettingBucketSchema.nullish(),
  filament: bambuCloudSettingBucketSchema.nullish()
}).passthrough()

export type BambuCloudSettingList = z.infer<typeof bambuCloudSettingListSchema>

/**
 * The detail envelope. The preset itself is under `.setting`; the envelope around it
 * carries the identity (`setting_id`, `base_id`, `type`).
 */
/**
 * One preset's full body, as returned by a detail read (`GET .../setting/<id>`) and by
 * create/update (`POST`/`PATCH`).
 *
 * Deliberately NOT built from `bambuCloudSettingSummarySchema`: the two look alike but
 * differ on the one field that matters. A listing row always carries `setting_id`; a
 * DETAIL read does not, you asked for it by id, so Bambu does not echo it back. Deriving
 * this from the summary made `setting_id` required and every single pull threw at the
 * parse before the preset was ever read, which reads as "every preset failed to sync"
 * with a Zod dump for a message. Verified against a live account: the detail response is
 * `{message, code, error, public, version, type, name, update_time, nickname, base_id,
 * setting, filament_id}`.
 *
 * `setting_id` stays optional here rather than being dropped, because create/update DO
 * return it, that is how a newly created preset's cloud id is learned.
 */
export const bambuCloudSettingDetailSchema = z.object({
  /** Present on create/update responses; absent on a detail read. */
  setting_id: z.string().min(1).optional(),
  name: z.string().optional(),
  type: bambuCloudPresetTypeSchema.nullish(),
  /** Bambu's clock, `"YYYY-MM-DD HH:MM:SS"` UTC. Parse with `parseBambuCloudUpdateTime`. */
  update_time: z.string().nullish(),
  base_id: z.string().nullish(),
  filament_id: z.string().nullish(),
  version: z.string().nullish(),
  nickname: z.string().nullish(),
  setting: z.record(z.unknown()).nullish()
}).passthrough()

export type BambuCloudSettingDetail = z.infer<typeof bambuCloudSettingDetailSchema>

/**
 * The body shape shared by create (`POST`) and update (`PATCH`): Bambu takes the
 * same envelope for both.
 *
 * `setting` is a **diff against the parent preset**, not a full config: BambuStudio's
 * `PresetCollection::get_differed_values_to_update` sends only the options that differ
 * from the `inherits` parent (the whole config only when there is no parent). Sending
 * a full config where Studio sends a diff would make every inherited value a local
 * override, so the preset would stop tracking its parent the next time Bambu updates it.
 */
export const bambuCloudSettingPayloadSchema = z.object({
  type: bambuCloudPresetTypeSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  /** Parent's cloud id. Empty string for a custom root, exactly as Studio sends it. */
  base_id: z.string(),
  /** Required by Bambu only for a root (`base_id` empty) filament preset. */
  filament_id: z.string().optional(),
  setting: z.record(z.unknown())
})

export type BambuCloudSettingPayload = z.infer<typeof bambuCloudSettingPayloadSchema>

/**
 * The operations this feature is allowed to perform, as a closed set.
 *
 * Deliberately an enum of named operations rather than a URL + method: the bridge
 * executes these on the workspace's own network, and a relay that forwarded an
 * arbitrary URL would be a general-purpose SSRF proxy into the LAN it sits on. The
 * bridge builds every URL itself from the region and the operation.
 */
export const bambuCloudOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('login'), account: z.string().min(1), password: z.string().min(1) }),
  z.object({ operation: z.literal('verifyEmailCode'), account: z.string().min(1), code: z.string().min(1) }),
  z.object({ operation: z.literal('verifyTotp'), tfaKey: z.string().min(1), code: z.string().min(1) }),
  z.object({ operation: z.literal('listSettings') }),
  z.object({ operation: z.literal('getSetting'), settingId: z.string().min(1) }),
  z.object({ operation: z.literal('createSetting'), payload: bambuCloudSettingPayloadSchema }),
  z.object({ operation: z.literal('patchSetting'), settingId: z.string().min(1), payload: bambuCloudSettingPayloadSchema }),
  z.object({ operation: z.literal('deleteSetting'), settingId: z.string().min(1) }),
  /**
   * Trades a refresh token for a fresh credential. The ONLY operation that runs on a
   * schedule, and it exists purely so a connection does not lapse into a full password +
   * 2FA sign-in while nobody is looking. Verified live: `POST
   * /v1/user-service/user/refreshtoken` answers 401 to a bad token, where neighbouring
   * invented paths answer 404.
   */
  z.object({ operation: z.literal('refreshToken'), refreshToken: z.string().min(1) })
])

export type BambuCloudOperation = z.infer<typeof bambuCloudOperationSchema>

export const bambuCloudRequestSchema = z.object({
  region: bambuCloudRegionSchema,
  /**
   * Bearer token for the operations that need one. A secret: it is held encrypted by
   * the API, passed to the bridge per call over the authenticated bridge session, and
   * never persisted bridge-side, logged, or returned to the browser.
   */
  accessToken: z.string().min(1).optional(),
  request: bambuCloudOperationSchema
})

export type BambuCloudRequest = z.infer<typeof bambuCloudRequestSchema>

/**
 * What a relay reports back: the raw HTTP outcome, plus the one credential Bambu
 * sometimes returns only as a response cookie, never a policy verdict.
 *
 * The bridge deploys separately from the API and lags it, so it deliberately does NOT
 * interpret the response, every "is this token dead / is this a Cloudflare challenge /
 * did this succeed" rule lives API-side, where it can be fixed by an API deploy alone.
 * The bridge's only job is to make the call and hand back what came out. Extracting
 * `tokenCookie` is transport normalization: cookie headers cannot otherwise cross the
 * RPC boundary, and the API still decides whether the response succeeded.
 */
export const bambuCloudResponseSchema = z.object({
  status: z.number().int(),
  /** Parsed JSON body, or null when the response was not JSON (an HTML challenge page). */
  body: z.unknown().nullable(),
  /**
   * Access token Bambu returned only in its `token` response cookie. The TOTP web
   * endpoint does not consistently echo this token in the JSON body. This is a secret:
   * the relay may return it to the authenticated API but must never log or persist it;
   * the API converts it into the normal encrypted credential immediately.
   */
  tokenCookie: z.string().min(1).max(8192).optional(),
  /**
   * The first part of a non-JSON body, so an unparseable response is diagnosable from
   * a log without replaying it. Truncated because a challenge page is large and this
   * crosses a WebSocket.
   */
  bodyText: z.string().max(2000).optional()
})

export type BambuCloudResponse = z.infer<typeof bambuCloudResponseSchema>

/** How much of a non-JSON body a relay keeps, matching `bodyText`'s cap. */
export const BAMBU_CLOUD_BODY_TEXT_LIMIT = 2000

/**
 * Whether a 401 is Bambu's genuine "this token is dead" answer.
 *
 * Expiry is signalled by `{"code":4,"error":"Please login."}`. Other 401s happen for
 * reasons that are not the credential, per-endpoint scope/region rejections, and
 * transient edge blips, so treating any 401 as expiry signs the workspace out on a
 * single stray rejection. An unsigned 401 is deliberately NOT expiry.
 */
export function isBambuCloudExpiryResponse(response: Pick<BambuCloudResponse, 'status' | 'body'>): boolean {
  if (response.status !== 401) return false
  const body = response.body
  if (!body || typeof body !== 'object') return false
  const record = body as Record<string, unknown>
  if (record.code === 4) return true
  const text = `${typeof record.error === 'string' ? record.error : ''} ${typeof record.message === 'string' ? record.message : ''}`
  return text.toLowerCase().includes('please login')
}

/**
 * Whether Bambu's edge served a Cloudflare challenge instead of the API.
 *
 * Worth detecting separately because it is neither an auth failure nor an outage, and
 * the fix is the user's, not ours: it clears after a while, or after signing in to
 * bambulab.com once from the same network. Diagnosed from the body because the
 * challenge arrives with assorted statuses.
 */
export function isBambuCloudChallengeResponse(response: Pick<BambuCloudResponse, 'status' | 'body' | 'bodyText'>): boolean {
  if (response.body !== null) return false
  const text = response.bodyText ?? ''
  if (text.includes('Just a moment...') || text.includes('challenges.cloudflare.com')) return true
  return response.status === 403 || response.status === 503
}

/**
 * Bambu's cloud limit on how many user presets an account may hold, surfaced as
 * `code: "14"` on a create. Studio stops creating presets of that type for the rest of
 * the session and tells the user; so do we, because retrying a quota rejection in a
 * loop is exactly the traffic that gets a client blocked.
 */
export function isBambuCloudQuotaResponse(response: Pick<BambuCloudResponse, 'status' | 'body'>): boolean {
  if (response.status < 400) return false
  const body = response.body
  if (!body || typeof body !== 'object') return false
  const code = (body as Record<string, unknown>).code
  return code === 14 || code === '14'
}

/**
 * Bambu's clock as epoch **seconds**, or null when it cannot be read.
 *
 * Two formats appear for the same instant: the listing and detail responses use
 * `"YYYY-MM-DD HH:MM:SS"` (UTC, no zone marker: appending `Z` is what keeps a server
 * in a non-UTC zone from reading it as local time), while `values_map` round-trips it
 * as a decimal unix-seconds string. Both are accepted so a caller never has to know
 * which endpoint a timestamp came from.
 *
 * Returns null rather than 0 for an unreadable value: 0 is a real, comparable
 * timestamp and would make an unparseable remote look infinitely old.
 */
export function parseBambuCloudUpdateTime(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10)
    return Number.isFinite(seconds) ? seconds : null
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/.exec(trimmed)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number]
  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second)
  if (!Number.isFinite(epochMs)) return null
  // Date.UTC ROLLS OVER out-of-range components instead of rejecting them (month 13
  // becomes January of the next year, hour 99 becomes four days later), so a garbage
  // timestamp would parse into a plausible-looking instant and silently win a
  // newest-wins comparison. Reading the components back is what rejects it.
  const parsed = new Date(epochMs)
  const roundTrips = parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute
    && parsed.getUTCSeconds() === second
  return roundTrips ? Math.floor(epochMs / 1000) : null
}

/** Serializes a Bambu timestamp back into the unix-seconds string its payloads carry. */
export function formatBambuCloudUpdateTime(epochSeconds: number): string {
  return String(Math.floor(epochSeconds))
}

/**
 * Whether the cloud copy of a preset should be pulled down, ported from
 * BambuStudio's `PresetCollection::need_sync`.
 *
 * Studio's rule is: pull when we have never seen this preset, when its cloud id
 * changed, or when the cloud's `update_time` is newer than the one we recorded. The
 * last clause is the load-bearing one and the reason `lastSyncedCloudUpdateTime` is
 * stored at all: it is **Bambu's own timestamp from our last successful sync**, so the
 * comparison is Bambu's clock against Bambu's clock. Substituting a local timestamp
 * here would hand every conflict to whichever machine's clock runs fast.
 *
 * A remote with no readable `update_time` is treated as newer, matching Studio's
 * `std::atoll` of an unparseable string (0) only in outcome, not in mechanism: we
 * cannot prove the local copy is current, and re-pulling is the recoverable mistake.
 */
export function shouldPullFromCloud(input: {
  /** Cloud id recorded for the local preset, or null when it was never synced. */
  lastSyncedSettingId: string | null
  /** Bambu's `update_time` as of the last successful sync, epoch seconds. */
  lastSyncedCloudUpdateTime: number | null
  /** The cloud id the listing reports now. */
  remoteSettingId: string
  /** The `update_time` the listing reports now, epoch seconds. */
  remoteCloudUpdateTime: number | null
}): boolean {
  if (!input.lastSyncedSettingId) return true
  if (input.lastSyncedSettingId !== input.remoteSettingId) return true
  if (input.remoteCloudUpdateTime === null) return true
  if (input.lastSyncedCloudUpdateTime === null) return true
  return input.lastSyncedCloudUpdateTime < input.remoteCloudUpdateTime
}
