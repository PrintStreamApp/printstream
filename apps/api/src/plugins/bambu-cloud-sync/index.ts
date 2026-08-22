/**
 * Bambu Cloud preset sync (built-in plugin, API side).
 *
 * Keeps a workspace's slicing presets in step with the preset library on a Bambu Lab
 * account, both ways: what is newer in the cloud is pulled down, what changed here is
 * pushed up, and a preset the user explicitly confirms removing is deleted there too.
 * The engine and its conflict rules live in `sync.ts`; this file owns the HTTP surface
 * and the sign-in flow.
 *
 * **Presets are never polled.** What is outstanding is worked out only when a person opens
 * a surface that uses presets (a cached check) or presses Sync — see `CHECK_CACHE_TTL_MS`.
 * The single exception is credential RENEWAL (`TOKEN_REFRESH_TICK_MS`), which is scheduled
 * for a different reason entirely: the token lapses on Bambu's clock, not on ours, and
 * letting it die means the user redoes password plus 2FA with no warning.
 *
 * **A plugin, not core.** It integrates with an external service, so an air-gapped,
 * LAN-only or simply uninterested install can remove it and keep a fully working preset
 * manager. Imported presets are ordinary workspace presets (`custom:<uuid>` rows through
 * `lib/slicing-presets.ts`) — removing the plugin strands the sync, never the presets.
 *
 * **This is not a walk-back of LAN Only Mode.** Nothing here touches a printer or asks
 * a printer to talk to Bambu. The only thing read or written is the *account's preset
 * library*, over the internet, from the API or the workspace's bridge.
 *
 * **Unofficial API.** Bambu publishes no contract for this and it can change without
 * notice, so every failure path degrades to "sync unavailable" and leaves the preset
 * manager working.
 */
import { z } from 'zod'
import {
  bambuCloudRegionSchema,
  extractErrorMessage,
  SETTINGS_MANAGE_PERMISSION
} from '@printstream/shared'
import type { ApiPlugin, ApiPluginContext, PluginSettingStore } from '../../plugin/types.js'
import type { RequestAuthActor } from '../../lib/auth-context.js'
import { annotateRequestAuditLog, skipRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { PLUGIN_SETTING_PREFIX } from '../../plugin/default-enable-mode.js'
import { rootPrisma } from '../../lib/prisma.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../../lib/request-helpers.js'
import { listCustomSlicingPresetRecords } from '../../lib/slicing-presets.js'
import {
  BambuCloudError,
  beginBambuCloudLogin,
  refreshBambuCloudCredential,
  type BambuCloudCredential,
  verifyBambuCloudEmailCode,
  verifyBambuCloudTotp
} from './client.js'
import { checkBambuCloudSync, resolvePendingDeletion, runBambuCloudSync } from './sync.js'
import {
  clearConnection,
  clearPresetBindings,
  publicConnectionState,
  readConnection,
  readPresetBindings,
  writeConnection
} from './state.js'

const PLUGIN_NAME = 'bambu-cloud-sync'

/**
 * How long a check's answer is reused before another one is allowed to reach Bambu.
 *
 * Preset state is NEVER polled: what is outstanding is worked out only when a person
 * opens a surface that uses presets, or presses Sync. A workspace nobody is looking at
 * generates no preset traffic at all. This TTL is what makes the on-open trigger safe —
 * opening the editor twenty times in ten minutes is one Bambu call, not twenty.
 *
 * (The one thing that DOES run on a timer is the credential refresh below, which is a
 * different question entirely — see `TOKEN_REFRESH_TICK_MS`.)
 */
const CHECK_CACHE_TTL_MS = 10 * 60_000

/**
 * How often to consider renewing credentials, and how far through a token's life to act.
 *
 * This is the only scheduled work in the plugin, and it exists for one reason: Bambu's
 * access token lapses on its own clock, and when it and the refresh token are both gone
 * the user must redo password plus 2FA — silently, at a moment nothing predicts. So the
 * tick is not a poll. It reads stored expiry times, does nothing for a workspace whose
 * token is still healthy, and calls Bambu roughly once per token lifetime.
 *
 * **Renewal is a FRACTION of the token's life, not a fixed lead, because Bambu expires
 * both tokens at the same instant.** Measured on a live account: `expiresIn` and
 * `refreshExpiresIn` were identical, 90 days out. So waiting until the access token is
 * nearly dead means reaching for a refresh token that is also nearly dead — one missed
 * window (server down, workspace paused) and the account needs a full 2FA sign-in. At 75%
 * of a 90-day life that leaves a three-week margin, and it still only costs one call per
 * token. A fraction also survives Bambu changing the lifetime: a fixed lead would be
 * reckless on a short token and wasteful on a long one.
 */
const TOKEN_REFRESH_TICK_MS = 6 * 60 * 60_000
const TOKEN_REFRESH_LIFETIME_FRACTION = 0.75
/** Delay before the first tick so a restart does not stampede every workspace at once. */
const TOKEN_REFRESH_START_DELAY_MS = 2 * 60_000

const connectRequestSchema = z.object({
  region: bambuCloudRegionSchema.default('global'),
  account: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200)
})

const verifyRequestSchema = z.object({
  region: bambuCloudRegionSchema.default('global'),
  account: z.string().trim().min(1).max(320),
  code: z.string().trim().min(1).max(32),
  /** Present for an authenticator-app account; absent for an emailed code. */
  tfaKey: z.string().trim().min(1).max(500).optional()
})

const resolveDeleteRequestSchema = z.object({
  /**
   * `confirm` carries out the deletion the freeze is asking about (delete the local
   * copy for a `missingRemotely` binding; queue the cloud copy's removal for a
   * `missingLocally` one). `decline` keeps both sides as they are now and simply stops
   * tracking the binding — a `missingRemotely` preset becomes an ordinary local-only
   * preset (synced fresh, as new, next pass); a `missingLocally` one leaves the cloud
   * copy untouched and forgotten.
   */
  action: z.enum(['confirm', 'decline'])
})

export const bambuCloudSyncPlugin: ApiPlugin = {
  name: PLUGIN_NAME,
  version: '1.0.0',
  description: 'Sync slicing presets with a Bambu Lab account, both ways.',
  runtimeSurfaces: ['workspace'],
  managerSurfaces: ['platform', 'workspace'],

  register(context: ApiPluginContext) {
    const { router, logger } = context

    router.get('/status', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = requireRequestWorkspaceId(request)
      const store = context.settings.forWorkspace(workspaceId)
      const connection = await readConnection(store, logger)
      const bindings = await readPresetBindings(store)
      const active = bindings.filter((binding) => !binding.pendingConfirmation)
      // A fresher name for `missingRemotely` (the local preset still exists and may have
      // been renamed since); `missingLocally` has no live preset to read one from, so it
      // keeps whatever name the binding recorded — see `reconcileDeletions` in sync.ts.
      const presetsById = new Map((await listCustomSlicingPresetRecords(workspaceId)).map((preset) => [preset.id, preset]))
      response.json({
        connection: publicConnectionState(connection),
        syncedPresetCount: active.length,
        heldPresetCount: active.filter((binding) => binding.hold).length,
        // Read straight off the last background check — this endpoint must stay free of
        // Bambu calls, because the editor and print-prep dialog poll it on every open.
        outstanding: connection?.lastCheck
          ? {
              at: connection.lastCheck.at,
              pullable: connection.lastCheck.pullable,
              pushable: connection.lastCheck.pushable,
              // Counted live rather than from the check, so resolving a decision updates
              // the badge immediately instead of waiting for the next pass.
              pending: bindings.filter((binding) => binding.pendingConfirmation).length
            }
          : null,
        pendingDeletionConfirmations: bindings
          .filter((binding) => binding.pendingConfirmation)
          .map((binding) => ({
            presetId: binding.presetId,
            name: presetsById.get(binding.presetId)?.name ?? binding.name,
            kind: binding.kind,
            direction: binding.pendingConfirmation?.kind,
            detectedAt: binding.pendingConfirmation?.detectedAt
          }))
      })
    })

    router.post('/connect', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = requireRequestWorkspaceId(request)
      const parsed = connectRequestSchema.safeParse(request.body)
      if (!parsed.success) throw badRequest('A Bambu Cloud account and password are required.')

      const result = await beginBambuCloudLogin(
        { workspaceId, logger },
        parsed.data.region,
        parsed.data.account,
        parsed.data.password
      )

      annotateRequestAuditLog(request, {
        action: 'bambu-cloud.connect.start',
        resource: 'bambu-cloud-connection',
        summary: `Started connecting a Bambu Cloud account (${parsed.data.region}).`,
        // The account is the user's own identifier and is shown in the UI; the password
        // and any issued token are never recorded.
        metadata: { region: parsed.data.region, verification: result.status }
      })

      if (result.status === 'authenticated') {
        await storeCredential(context.settings.forWorkspace(workspaceId), parsed.data.region, parsed.data.account, result.credential, request.auth?.actor)
        response.json({ status: 'connected' })
        return
      }
      response.json(result.status === 'needsTotp'
        ? { status: 'needsTotp', tfaKey: result.tfaKey }
        : { status: 'needsEmailCode' })
    })

    router.post('/connect/verify', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = requireRequestWorkspaceId(request)
      const parsed = verifyRequestSchema.safeParse(request.body)
      if (!parsed.success) throw badRequest('A verification code is required.')

      const callContext = { workspaceId, logger }
      const accessToken = parsed.data.tfaKey
        ? await verifyBambuCloudTotp(callContext, parsed.data.region, parsed.data.tfaKey, parsed.data.code)
        : await verifyBambuCloudEmailCode(callContext, parsed.data.region, parsed.data.account, parsed.data.code)

      await storeCredential(context.settings.forWorkspace(workspaceId), parsed.data.region, parsed.data.account, accessToken, request.auth?.actor)
      annotateRequestAuditLog(request, {
        action: 'bambu-cloud.connect.complete',
        resource: 'bambu-cloud-connection',
        summary: 'Connected a Bambu Cloud account to this workspace.',
        metadata: { region: parsed.data.region, method: parsed.data.tfaKey ? 'totp' : 'email-code' }
      })
      response.json({ status: 'connected' })
    })

    router.post('/disconnect', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = requireRequestWorkspaceId(request)
      const store = context.settings.forWorkspace(workspaceId)
      await clearConnection(store)
      // The bindings go with the credential: they describe another account's preset ids,
      // and keeping them would silently re-bind a DIFFERENT account's presets to these
      // local ones on the next connect. The presets themselves stay.
      await clearPresetBindings(store)
      annotateRequestAuditLog(request, {
        action: 'bambu-cloud.disconnect',
        resource: 'bambu-cloud-connection',
        summary: 'Disconnected the Bambu Cloud account. Imported presets were kept.'
      })
      response.json({ status: 'disconnected' })
    })

    router.post('/sync', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = requireRequestWorkspaceId(request)
      const result = await runBambuCloudSync({ workspaceId, store: context.settings.forWorkspace(workspaceId), logger })
      annotateRequestAuditLog(request, {
        action: 'bambu-cloud.sync',
        resource: 'bambu-cloud-connection',
        summary: `Synced presets with Bambu Cloud (${result.pulled.length} in, ${result.created.length + result.updated.length} out).`,
        metadata: {
          pulled: result.pulled.length,
          created: result.created.length,
          updated: result.updated.length,
          deleted: result.deleted.length,
          failed: result.failed.length,
          // Without these a pass that froze deletions reads as a no-op in the audit
          // trail, which is exactly how a six-preset deletion looked after the fact.
          missingLocally: result.missingLocally.length,
          missingRemotely: result.missingRemotely.length,
          route: result.route
        }
      })
      response.json(result)
    })

    /**
     * What a sync would do, without doing any of it. THE trigger for reaching Bambu.
     *
     * Called by the surfaces that use presets when they open. No preset is created,
     * edited or deleted, and nothing is written to Bambu. Bambu's LISTING is reused while
     * it is younger than {@link CHECK_CACHE_TTL_MS} — the verdict itself is always
     * recomputed, so a preset edited here is reflected immediately — and `force` skips
     * even that.
     *
     * A workspace with no account connected is a 200 with `connected: false`, not an
     * error: every editor open would otherwise log a 4xx for a perfectly normal state.
     */
    router.post('/check', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = requireRequestWorkspaceId(request)
      const store = context.settings.forWorkspace(workspaceId)
      const connection = await readConnection(store, logger)
      if (!connection) {
        skipRequestAuditLog(request)
        response.json({ connected: false })
        return
      }

      const force = request.body != null && (request.body as { force?: unknown }).force === true
      // The plan is ALWAYS recomputed; only Bambu's listing is reused. So a preset edited
      // or deleted here shows up on the very next look, while Bambu is still called at
      // most once per TTL.
      const plan = await checkBambuCloudSync({ workspaceId, store, logger }, { maxListingAgeMs: force ? 0 : CHECK_CACHE_TTL_MS })
      // Deliberately unaudited: every editor and print-prep open calls this, and it changes
      // nothing a reviewer would ever ask about — it records what is outstanding and freezes
      // a binding whose two sides disagree. The acts that follow from it (`/sync`,
      // `/presets/:id/resolve-delete`) are the ones that carry consequences, and both are
      // annotated.
      skipRequestAuditLog(request)
      response.json({
        connected: true,
        status: 'connected',
        checkedAt: new Date().toISOString(),
        pullable: plan.pullable.length,
        pushable: plan.pushable.length,
        pending: plan.pending.length,
        held: plan.held.length,
        route: plan.route
      })
    })

    /**
     * Answers a deletion the sync engine froze — see `reconcileDeletions` in `sync.ts`.
     * A deletion on EITHER side always lands here rather than happening on its own; the
     * actual state transition lives in `resolvePendingDeletion` so it stays testable
     * without an HTTP harness.
     */
    router.post('/presets/:presetId/resolve-delete', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = requireRequestWorkspaceId(request)
      const presetId = requireRouteParam(request.params.presetId, 'presetId')
      const parsed = resolveDeleteRequestSchema.safeParse(request.body ?? {})
      if (!parsed.success) throw badRequest('Invalid request.')

      const resolved = await resolvePendingDeletion(workspaceId, context.settings.forWorkspace(workspaceId), logger, presetId, parsed.data.action)
      if (!resolved) throw notFound('No pending Bambu Cloud deletion decision for that preset.')

      annotateRequestAuditLog(request, {
        action: 'bambu-cloud.preset.resolve-delete',
        resource: 'slicing-preset',
        summary: `Resolved a Bambu Cloud ${resolved.kind === 'missingRemotely' ? 'cloud-side' : 'local'} deletion (${parsed.data.action}).`,
        metadata: { presetId, kind: resolved.kind, action: parsed.data.action }
      })
      response.json({ status: 'resolved' })
    })

    // Publish the workspace's connection to the core seam other built-in plugins read
    // (`lib/bambu-account-registry.ts`). Consumers gate on their own explicit opt-in;
    // connecting an account here is consent to sync presets, nothing more. An expired
    // credential resolves to null rather than handing out a token that will 401.
    context.registerBambuAccountResolver(async ({ workspaceId }) => {
      const connection = await readConnection(context.settings.forWorkspace(workspaceId), logger)
      if (!connection || connection.status !== 'connected') return null
      if (connection.expiresAt && new Date(connection.expiresAt) <= new Date()) return null
      return {
        accessToken: connection.accessToken,
        region: connection.region,
        accountLabel: connection.account
      }
    })

    const timers = startTokenRefresh(context)
    context.onShutdown(() => {
      for (const timer of timers) clearTimeout(timer)
    })
  }
}

/**
 * Keeps stored credentials alive. The ONLY scheduled work in this plugin.
 *
 * Deliberately not a sync and not a preset check: it reads expiry times that are already
 * stored, and contacts Bambu only for a workspace whose access token is about to lapse.
 * A healthy workspace costs zero calls per tick.
 *
 * Three outcomes per workspace, and the distinction matters:
 *  - token still good → nothing, no call;
 *  - refresh token present and usable → renew, and the user never notices;
 *  - refresh token missing or refused → mark expired, because no amount of retrying
 *    fixes it and the UI needs to ask for a reconnect rather than fail silently.
 */
function startTokenRefresh(context: ApiPluginContext): NodeJS.Timeout[] {
  const timers: NodeJS.Timeout[] = []
  let stopped = false
  context.onShutdown(() => { stopped = true })

  const runTick = async (): Promise<void> => {
    if (stopped) return
    for (const workspaceId of await listConnectedWorkspaceIds()) {
      if (stopped) return
      if (context.isEnabledForWorkspace && !context.isEnabledForWorkspace(workspaceId)) continue
      try {
        await refreshWorkspaceCredentialIfDue(workspaceId, context)
      } catch (error) {
        // Never let one workspace's failure stop the rest, or take the process down.
        context.logger.warn(`Bambu Cloud credential refresh failed for workspace ${workspaceId}: ${extractErrorMessage(error)}`)
      }
    }
  }

  const schedule = (delayMs: number): void => {
    if (stopped) return
    const timer = setTimeout(() => {
      void runTick().finally(() => schedule(TOKEN_REFRESH_TICK_MS))
    }, delayMs)
    // Never hold the process open for a renewal that can just as well happen next boot.
    timer.unref?.()
    timers.push(timer)
  }

  schedule(TOKEN_REFRESH_START_DELAY_MS)
  return timers
}

/**
 * Whether a credential is far enough through its own lifetime to renew.
 *
 * Exported for tests: this is pure arithmetic, and it is the rule that decides whether an
 * account silently loses its sign-in, so it deserves to be checked directly rather than
 * only through a scheduler.
 */
export function isBambuCredentialDueForRenewal(issuedAt: string | null | undefined, expiresAtMs: number, nowMs: number): boolean {
  const issuedAtMs = issuedAt ? Date.parse(issuedAt) : Number.NaN
  // Without a known issue time there is no lifetime to take a fraction of. Fall back to
  // renewing once the token is inside its last quarter-day — better a late renewal than
  // none, and this only applies to credentials stored before `issuedAt` existed.
  if (!Number.isFinite(issuedAtMs) || issuedAtMs >= expiresAtMs) return expiresAtMs - nowMs <= 6 * 60 * 60_000
  const lifetime = expiresAtMs - issuedAtMs
  return nowMs - issuedAtMs >= lifetime * TOKEN_REFRESH_LIFETIME_FRACTION
}

/** Renews one workspace's credential if it is close enough to expiry to need it. */
async function refreshWorkspaceCredentialIfDue(workspaceId: string, context: ApiPluginContext): Promise<void> {
  const store = context.settings.forWorkspace(workspaceId)
  const connection = await readConnection(store, context.logger)
  if (!connection || connection.status === 'expired') return

  // Unknown expiry means Bambu did not state one. Renewing on a guessed schedule would
  // be exactly the pointless traffic this design avoids, so leave it: a token that dies
  // is reported honestly and the user reconnects.
  if (!connection.expiresAt) return
  const expiresAt = Date.parse(connection.expiresAt)
  if (!Number.isFinite(expiresAt)) return
  if (!isBambuCredentialDueForRenewal(connection.issuedAt ?? connection.connectedAt, expiresAt, Date.now())) return

  const refreshExpiresAt = connection.refreshExpiresAt ? Date.parse(connection.refreshExpiresAt) : null
  const refreshUsable = connection.refreshToken
    && (refreshExpiresAt === null || !Number.isFinite(refreshExpiresAt) || refreshExpiresAt > Date.now())
  if (!refreshUsable) {
    // No refresh token (or it has outlived its own window). Nothing to try — but the
    // ACCESS token may still be perfectly good, so say nothing and change nothing. The
    // connection is marked expired only when Bambu actually rejects it in real use.
    return
  }

  try {
    const credential = await refreshBambuCloudCredential(
      { workspaceId, logger: context.logger },
      connection.region,
      connection.refreshToken as string
    )
    await writeConnection(store, {
      ...connection,
      accessToken: credential.accessToken,
      // Bambu issues a NEW refresh token alongside the new access token; keeping the old
      // one would pin the connection to the original refresh window and defeat the point.
      refreshToken: credential.refreshToken ?? connection.refreshToken,
      expiresAt: credential.expiresAt,
      refreshExpiresAt: credential.refreshExpiresAt ?? connection.refreshExpiresAt,
      issuedAt: new Date().toISOString(),
      status: 'connected',
      lastError: null
    })
    context.logger.info(`Renewed the Bambu Cloud credential for workspace ${workspaceId}.`)
  } catch (error) {
    // **A failed renewal must never disconnect a working account.** Renewal is an
    // optimisation on top of a credential that is still valid until `expiresAt`; treating
    // its failure as expiry would throw away a good token — and this endpoint is not
    // currently known to work at all (see the note on `refreshBambuCloudCredential`), so
    // that would disconnect every account at 75% of its life for no reason. Log it and
    // leave the credential exactly as it is; genuine expiry is detected where it actually
    // shows up, when Bambu rejects the access token on a real call.
    context.logger.warn(
      `Could not renew the Bambu Cloud credential for workspace ${workspaceId}; leaving the existing sign-in in place `
      + `(it remains valid until ${connection.expiresAt ?? 'an unknown time'}): ${extractErrorMessage(error)}`
    )
  }
}

async function storeCredential(
  store: PluginSettingStore,
  region: z.infer<typeof bambuCloudRegionSchema>,
  account: string,
  credential: BambuCloudCredential,
  actor: RequestAuthActor | undefined
): Promise<void> {
  await writeConnection(store, {
    region,
    account,
    accessToken: credential.accessToken,
    // Kept so the connection can outlive the access token. Dropping these was a real
    // defect: with only the access token, the sign-in lapses at a moment nothing can
    // predict and the user has to redo password plus 2FA with no warning.
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAt,
    refreshExpiresAt: credential.refreshExpiresAt,
    issuedAt: new Date().toISOString(),
    connectedAt: new Date().toISOString(),
    // A per-workspace credential still has a person behind it: the workspace needs to
    // be able to see whose account is backing everyone's presets.
    connectedByUserId: actor?.type === 'user' ? actor.userId : null,
    status: 'connected',
    lastSyncedAt: null,
    lastError: null,
    // A fresh sign-in clears every prior sign-in's bookkeeping: a quota may have been
    // freed, a queued delete or an ignored preset belongs to whichever account is
    // connected now, not necessarily this one.
    quotaBlockedKinds: [],
    pendingDeletes: [],
    ignoredRemoteSettingIds: []
  })
}

/**
 * Workspaces holding a Bambu Cloud credential, read straight off the setting keys.
 *
 * The plugin setting store is per-workspace by key prefix and has no "list workspaces"
 * operation, so the background pass recovers the ids from the keys it wrote. Matching
 * on the connection key specifically means a workspace that only ever had bindings (an
 * old disconnect) is not woken up for nothing.
 */
async function listConnectedWorkspaceIds(): Promise<string[]> {
  const prefix = `${PLUGIN_SETTING_PREFIX}${PLUGIN_NAME}:workspace:`
  const rows = await rootPrisma.setting.findMany({
    where: { key: { startsWith: prefix }, AND: { key: { endsWith: ':connection' } } },
    select: { key: true }
  })
  return rows
    .map((row) => row.key.slice(prefix.length).replace(/:connection$/, ''))
    .filter((workspaceId) => workspaceId.length > 0)
}

/** Re-exported for the tests, which drive the engine directly rather than over HTTP. */
export { runBambuCloudSync, BambuCloudError, listCustomSlicingPresetRecords }
