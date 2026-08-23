/**
 * Persisted state for one workspace's Bambu Cloud connection: the credential, and the
 * binding between each cloud preset and the local preset it corresponds to.
 *
 * Stored in the plugin's workspace-scoped setting store (so it disappears with the
 * plugin, and never leaks between workspaces) rather than in a new table: it is small,
 * read whole, and written whole.
 *
 * **The binding is by id, both ways.** A record maps Bambu's `setting_id` to our
 * `custom:<uuid>`. Nothing in a sync matches presets by NAME: names are display text,
 * they drift, and two kinds can share one. (BambuStudio does match by name locally,
 * which is why renaming a preset in Studio forks it into two; keying on the id is what
 * makes a rename stay one preset here.)
 *
 * **The two timestamps are not interchangeable.** `cloudUpdateTime` is Bambu's clock,
 * compared only against Bambu's clock, to decide whether the cloud copy is newer.
 * `localUpdatedAt` is ours, compared only against ours, to decide whether the user has
 * edited the preset here since the last sync. Comparing one against the other would
 * hand every conflict to whichever machine's clock runs fast.
 *
 * **Only the ACCESS token is encrypted at rest** (via `secret-encryption.ts`); the
 * refresh token beside it is stored verbatim. Both are secrets and neither may reach
 * a DTO, see `publicConnectionState`, but their at-rest protection differs today.
 * The `refreshToken` field doc explains why and what the fix costs; do not read this
 * paragraph as "the credential is encrypted".
 */
import { z } from 'zod'
import { bambuCloudRegionSchema, slicingPresetKindSchema } from '@printstream/shared'
import { decryptSecret, encryptSecret } from '../../lib/secret-encryption.js'
import type { PluginLogger, PluginSettingStore } from '../../plugin/types.js'

const CONNECTION_KEY = 'connection'
const PRESET_BINDINGS_KEY = 'presetBindings'

/**
 * Why a preset is not currently syncing. Mirrors BambuStudio's `sync_info = "hold"`:
 * a preset Bambu rejected with a 4xx is parked rather than retried on every pass,
 * because retrying a rejection in a loop is what gets a client rate-limited.
 */
const presetHoldSchema = z.object({
  reason: z.string(),
  at: z.string()
})

/**
 * A deletion this sync noticed on one side but has not been told what to do about.
 *
 * `missingRemotely` means the preset vanished from Bambu's listing (deleted in Studio
 * or the account) while the local copy survives. `missingLocally` means the local
 * preset is gone (deleted here, by any path: the normal delete button does not need
 * to know this plugin exists) while Bambu's copy survives. Either way the binding is
 * FROZEN the moment this is set: pull/push skip it entirely until a person resolves
 * it via `/presets/:presetId/resolve-delete`, so a deletion never propagates on its own.
 */
const pendingDeletionConfirmationSchema = z.object({
  kind: z.enum(['missingLocally', 'missingRemotely']),
  detectedAt: z.string()
})

export type PendingDeletionConfirmation = z.infer<typeof pendingDeletionConfirmationSchema>

const presetBindingSchema = z.object({
  /** Bambu's id for this preset. The identity of the binding. */
  settingId: z.string().min(1),
  /** Our `custom:<uuid>`. Survives an edit because the preset store preserves ids. */
  presetId: z.string().min(1),
  kind: slicingPresetKindSchema,
  /**
   * The preset's name as of the last successful sync. Kept on the binding (not just
   * read off the live preset) because `missingLocally` needs a name to show the user
   * for a preset that, by definition, no longer exists to read one from.
   */
  name: z.string(),
  /** Bambu's `update_time` as of the last successful sync, epoch seconds. */
  cloudUpdateTime: z.number().int().nullable(),
  /** Our `updatedAt` as of the last successful sync. A difference means a local edit. */
  localUpdatedAt: z.string().nullable(),
  /** The parent's cloud id, which a child preset must send as its own `base_id`. */
  baseId: z.string().nullable(),
  hold: presetHoldSchema.nullish(),
  pendingConfirmation: pendingDeletionConfirmationSchema.nullish()
})

export type BambuPresetBinding = z.infer<typeof presetBindingSchema>

const connectionSchema = z.object({
  region: bambuCloudRegionSchema,
  /** The account as the user typed it, for the "connected as" line. Not a secret. */
  account: z.string(),
  /** Encrypted at rest. Never returned to the browser. */
  accessToken: z.string(),
  /**
   * NOT encrypted at rest: unlike {@link accessToken}, this is stored verbatim.
   * `writeConnection` encrypts only the access token, so with `SECRETS_KEY` set the
   * two halves of the same credential have different protection, and a reader of the
   * `Setting` table gets a token that mints fresh access tokens. That is a gap, not a
   * decision; it is recorded here rather than quietly implied because the previous
   * version of this comment claimed the opposite and was believed.
   *
   * Fixing it is small and back-compatible: encrypt on write and decrypt on read, as
   * the access token does. `secret-encryption.ts` stores a self-describing `enc:1:`
   * prefix and returns unprefixed values unchanged, so already-stored plaintext keeps
   * working and is re-encrypted on the next write, no migration, no forced reconnect.
   *
   * Bambu issues this alongside every access token (`TokenResp` in BambuStudio's
   * `HttpServer.cpp`); without it a lapsed access token means a full password + 2FA
   * sign-in again, with no warning. Nullable because an older stored connection
   * predates this field.
   */
  refreshToken: z.string().nullish(),
  /**
   * When each token lapses, as absolute instants. Bambu states these as SECONDS FROM NOW
   * (`expiresIn` / `refreshExpiresIn`), which is meaningless once persisted, so they are
   * resolved against the clock at sign-in. Null means Bambu did not say.
   *
   * Observed against a live account: both are **the same instant**, 90 days out. The
   * refresh token does NOT outlive the access token, so renewal cannot be left until the
   * access token is nearly dead, at that point the refresh token is nearly dead too.
   */
  expiresAt: z.string().nullish(),
  refreshExpiresAt: z.string().nullish(),
  /**
   * When the CURRENT credential was issued (sign-in or last renewal). Stored so renewal
   * can be scheduled as a fraction of the token's own lifetime rather than a fixed lead:
   * a fixed lead is either reckless on a short token or wasteful on a long one, and
   * Bambu's lifetime is its own business to change.
   */
  issuedAt: z.string().nullish(),
  connectedAt: z.string(),
  /** Who connected it, a per-workspace credential still has a person behind it. */
  connectedByUserId: z.string().nullable(),
  /**
   * `expired` means Bambu answered with its signed expiry. Only that sets it; an
   * unreachable cloud or a Cloudflare challenge leaves the last known state alone.
   */
  status: z.enum(['connected', 'expired']),
  lastSyncedAt: z.string().nullish(),
  lastError: z.string().nullish(),
  /**
   * Preset kinds that hit Bambu's account quota. Creating more of that kind keeps
   * failing until the user frees space, so we stop trying and say so, as Studio does.
   */
  quotaBlockedKinds: z.array(slicingPresetKindSchema).default([]),
  /**
   * Cloud presets deleted here whose removal has not been accepted upstream yet.
   * Queued rather than fire-and-forget so a delete the user confirmed is not silently
   * lost to a network blip; retried on the next pass.
   */
  pendingDeletes: z.array(z.string()).default([]),
  /**
   * Bambu `setting_id`s a person deliberately chose to stop tracking after a
   * `missingLocally` freeze: the preset was deleted here, and declining the "remove
   * from Bambu Cloud too?" prompt means "leave the cloud copy alone", not "bring it
   * back". Without this, dropping the binding alone would make the very next pull look
   * at Bambu's still-listed copy, see no binding, and re-import it: reappearing right
   * after the user deleted it, the opposite of what they asked for. Cleared on
   * disconnect along with the rest of the connection; there is no in-app way to
   * un-ignore one today short of reconnecting.
   */
  ignoredRemoteSettingIds: z.array(z.string()).default([]),
  /**
   * What the last CHECK found, and when. Written by `checkBambuCloudSync` (the background
   * pass and the explicit refresh) so a surface can show whether anything is outstanding
   * without making a Bambu call of its own, an editor open must not cost an API request.
   * Distinct from `lastSyncedAt`, which records the last time work was actually done.
   */
  lastCheck: z.object({
    at: z.string(),
    pullable: z.number().int(),
    pushable: z.number().int(),
    pending: z.number().int()
  }).nullish()
})

export type BambuCloudConnection = z.infer<typeof connectionSchema>

/**
 * The connection as the browser may see it: everything except the token.
 *
 * Built by omission of the one secret field rather than by listing the safe ones, so a
 * field added above cannot be forgotten here, but the token is named explicitly, so
 * removing it can never be an accident either.
 */
export interface PublicBambuCloudConnection extends Omit<BambuCloudConnection, 'accessToken'> {
  /** True when a token is held at all, never the token itself. */
  hasCredential: boolean
}

export function publicConnectionState(connection: BambuCloudConnection | null): PublicBambuCloudConnection | null {
  if (!connection) return null
  const { accessToken: _accessToken, ...safe } = connection
  return { ...safe, hasCredential: true }
}

export async function readConnection(store: PluginSettingStore, logger: PluginLogger): Promise<BambuCloudConnection | null> {
  const raw = await store.get(CONNECTION_KEY)
  if (!raw) return null
  const parsed = connectionSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    logger.warn('Stored Bambu Cloud connection could not be read; treating the workspace as disconnected.')
    return null
  }
  try {
    return { ...parsed.data, accessToken: decryptSecret(parsed.data.accessToken) }
  } catch (error) {
    // A credential we cannot decrypt (SECRETS_KEY rotated or unset) is unusable. Report
    // disconnected rather than throwing, so the preset manager keeps working and the
    // user can simply reconnect.
    logger.warn(`Stored Bambu Cloud credential could not be decrypted: ${(error as Error).message}`)
    return null
  }
}

/**
 * Persists the connection. Encrypts the access token ONLY: `refreshToken` goes to
 * storage as-is; see its field doc. If you add encryption there, add the matching
 * `decryptSecret` to {@link readConnection} in the same change, or every existing
 * connection reads back as ciphertext and silently fails to refresh.
 */
export async function writeConnection(store: PluginSettingStore, connection: BambuCloudConnection): Promise<void> {
  await store.set(CONNECTION_KEY, JSON.stringify({ ...connection, accessToken: encryptSecret(connection.accessToken) }))
}

export async function clearConnection(store: PluginSettingStore): Promise<void> {
  await store.delete(CONNECTION_KEY)
}

/**
 * Marks the credential dead. Called ONLY for Bambu's signed expiry, never for a bare
 * 401, an unreachable cloud, or a challenge, any of which would otherwise disconnect a
 * session that still works.
 */
export async function markConnectionExpired(store: PluginSettingStore, connection: BambuCloudConnection, message: string): Promise<void> {
  await writeConnection(store, { ...connection, status: 'expired', lastError: message })
}

export async function readPresetBindings(store: PluginSettingStore): Promise<BambuPresetBinding[]> {
  const raw = await store.get(PRESET_BINDINGS_KEY)
  if (!raw) return []
  const parsed = z.array(presetBindingSchema).safeParse(JSON.parse(raw))
  return parsed.success ? parsed.data : []
}

export async function writePresetBindings(store: PluginSettingStore, bindings: BambuPresetBinding[]): Promise<void> {
  await store.set(PRESET_BINDINGS_KEY, JSON.stringify(bindings))
}

export async function clearPresetBindings(store: PluginSettingStore): Promise<void> {
  await store.delete(PRESET_BINDINGS_KEY)
}
