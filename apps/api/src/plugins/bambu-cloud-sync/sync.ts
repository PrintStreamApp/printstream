/**
 * The two-way preset sync itself: pull what is newer in the cloud, push what changed
 * here, and propagate the deletes the user confirmed.
 *
 * Ported from BambuStudio's own sync (`GUI_App::sync_preset` +
 * `PresetCollection::need_sync` in the vendored source), because the goal is to be a
 * well-behaved second client on a library Studio also writes to, not to invent a
 * better protocol for an API we do not control.
 *
 * **Ordering is the conflict rule.** Pull runs first, then push. That is what makes a
 * genuine two-sided conflict resolve cloud-wins: if the cloud copy is newer it lands
 * locally first, which also resets the local-edit marker, so the push pass has nothing
 * left to send. There is no timestamp comparison ACROSS the two clocks anywhere: see
 * `state.ts` for why that matters.
 *
 * **A preset is never pushed before its parent.** A child's `base_id` must be the
 * parent's cloud id, so a child whose parent has not been created yet is left for the
 * next pass rather than uploaded with an empty parent (which would silently detach it
 * from the preset it inherits). This mirrors `PresetCollection::get_user_presets`.
 *
 * **Failures park, they do not retry.** Anything Bambu rejects with a 4xx puts that one
 * preset on hold with a reason, exactly as Studio's `sync_info = "hold"` does: retrying
 * a rejection every pass is what turns one broken preset into rate-limiting for the
 * whole account. A hold is cleared when the user edits the preset or reconnects.
 *
 * **A deletion on either side is a question, never an action.** `reconcileDeletions`
 * runs before pull/push and diffs each binding's two sides, does the local preset
 * still exist, does Bambu's listing still carry the setting id, against the current
 * remote listing and the local preset table. A binding missing on exactly one side is
 * FROZEN (removed from the active set pull/push operate on, so neither can quietly
 * recreate the missing half) and reported for a person to resolve via
 * `/presets/:presetId/resolve-delete`; the API index owns what each answer does.
 * Missing on BOTH sides needs no question: the binding is simply dropped. Symmetric
 * with the earlier `pendingDeletes` queue (still used for the confirmed-delete-from-
 * here-too case), except that queue only ever fires from an explicit user action,
 * this reconciliation is what NOTICES a deletion that happened outside PrintStream's
 * own delete flow (Studio, or the ordinary local delete button, which has no reason to
 * know this plugin exists).
 */
import {
  BAMBU_SLICER_API_VERSION,
  bambuCloudTypeFromPresetKind,
  decodeCloudPresetSetting,
  encodeCloudPresetSetting,
  parseBambuCloudUpdateTime,
  presetKindFromBambuCloudType,
  shouldPullFromCloud,
  type BambuCloudSettingPayload,
  type BambuCloudSettingSummary,
  type SlicingPresetKind
} from '@printstream/shared'
import {
  deleteCustomSlicingPreset,
  listCustomSlicingPresetRecords,
  upsertCustomSlicingPresetRecords,
  type StoredSlicingPreset
} from '../../lib/slicing-presets.js'
import {
  BambuCloudError,
  createBambuCloudSetting,
  deleteBambuCloudSetting,
  getBambuCloudSetting,
  listBambuCloudSettings,
  patchBambuCloudSetting,
  type BambuCloudSession
} from './client.js'
import {
  markConnectionExpired,
  readConnection,
  readPresetBindings,
  writeConnection,
  writePresetBindings,
  type BambuCloudConnection,
  type BambuPresetBinding
} from './state.js'
import { createKeyedMutex } from '../../lib/keyed-mutex.js'
import type { CallContext } from './client.js'
import type { PluginLogger, PluginSettingStore } from '../../plugin/types.js'

/**
 * Serializes every read-modify-write over a workspace's preset-bindings blob:
 * `runBambuCloudSync` (the background pass, and a user's "Sync now") and
 * `resolvePendingDeletion` (a user answering a pending-deletion banner) each read the
 * full bindings list, decide what changes, and write the whole list back, with no
 * locking that would otherwise let two of these overlap for one workspace and have the
 * later write silently clobber the earlier one (a confirmed deletion resurrected by a
 * sync that started before the resolve call, for instance). Keyed by workspaceId so
 * different workspaces still run fully concurrently.
 */
const workspaceSyncMutex = createKeyedMutex()

export interface SyncPresetOutcome {
  name: string
  kind: SlicingPresetKind
  detail?: string
}

/** A binding awaiting a person's decision: see `reconcileDeletions`. */
export interface PendingDeletionOutcome {
  presetId: string
  name: string
  kind: SlicingPresetKind
}

export interface BambuCloudSyncResult {
  /** Presets whose cloud copy was newer and has been written here. */
  pulled: SyncPresetOutcome[]
  /** Presets created in the cloud for the first time. */
  created: SyncPresetOutcome[]
  /** Presets updated in the cloud in place (PATCH). */
  updated: SyncPresetOutcome[]
  /** Cloud presets removed on the user's explicit confirmation. */
  deleted: string[]
  /** Presets deliberately left alone this pass, each with why. */
  skipped: SyncPresetOutcome[]
  /** Presets Bambu rejected. Each is now on hold and will not be retried. */
  failed: SyncPresetOutcome[]
  /**
   * Still local, but gone from Bambu's listing: deleted in Studio or the account.
   * Frozen until `/presets/:presetId/resolve-delete` says what to do.
   */
  missingRemotely: PendingDeletionOutcome[]
  /**
   * Still in Bambu Cloud, but the local preset is gone: deleted here by any path.
   * Frozen the same way.
   */
  missingLocally: PendingDeletionOutcome[]
  /** Whether the calls went out through the workspace's bridge or this server. */
  route: 'bridge' | 'direct'
}

function emptyResult(route: 'bridge' | 'direct'): BambuCloudSyncResult {
  return { pulled: [], created: [], updated: [], deleted: [], skipped: [], failed: [], missingRemotely: [], missingLocally: [], route }
}

interface SyncContext {
  workspaceId: string
  store: PluginSettingStore
  logger: PluginLogger
  signal?: AbortSignal
  /** Test seam; see `CallContext.call`. Unset in production. */
  call?: CallContext['call']
}

/**
 * Runs one full pass. Throws only when the whole sync cannot proceed (no credential,
 * expired credential, Bambu unreachable); a per-preset failure is reported in the
 * result so one bad preset never costs the rest of the library.
 */
export async function runBambuCloudSync(context: SyncContext): Promise<BambuCloudSyncResult> {
  return await workspaceSyncMutex.run(context.workspaceId, () => runBambuCloudSyncLocked(context))
}

async function runBambuCloudSyncLocked(context: SyncContext): Promise<BambuCloudSyncResult> {
  const connection = await readConnection(context.store, context.logger)
  if (!connection) throw new BambuCloudError('This workspace is not connected to a Bambu Cloud account.', 'http', 0)
  if (connection.status === 'expired') {
    throw new BambuCloudError('The Bambu Cloud sign-in has expired. Reconnect the account to keep syncing.', 'expired', 401)
  }

  const session: BambuCloudSession = { region: connection.region, accessToken: connection.accessToken }
  const callContext: CallContext = { workspaceId: context.workspaceId, logger: context.logger, signal: context.signal, call: context.call }

  try {
    const { list, route } = await listBambuCloudSettings(callContext, session)
    const result = emptyResult(route)

    const remote = collectRemotePresets(list)
    // A snapshot taken NOW, before pull writes anything: reconciliation only needs to
    // know which presets currently exist, and using this rather than a fresh fetch
    // after pull matters: push (below) needs its OWN fresh fetch taken AFTER pull, so
    // its local-edit check compares against what pull just wrote, not what was here
    // before the sync started.
    const presetsBeforeSync = await listCustomSlicingPresetRecords(context.workspaceId)
    const allBindings = await readPresetBindings(context.store)

    // Same planner the cheap check uses, so what a surface shows as outstanding and what
    // this pass actually does are one decision, not two that can disagree. It also owns
    // the pull exclusions: frozen bindings, declined imports (`ignoredRemoteSettingIds`)
    // and confirmed-but-not-yet-drained deletes (`pendingDeletes`); that last one because
    // `propagateConfirmedDeletes` runs AFTER pull here, so without it pull re-imports the
    // preset the user just deleted and the next pass pushes it back up as new.
    const { reconciled, excludedSettingIds } = planFromState(remote, presetsBeforeSync, allBindings, connection, route)
    result.missingRemotely.push(...reconciled.missingRemotely)
    result.missingLocally.push(...reconciled.missingLocally)
    const frozenPresetIds = new Set(reconciled.frozen.map((binding) => binding.presetId))

    let bindings = reconciled.active

    bindings = await pullNewerCloudPresets(context, callContext, session, remote, bindings, excludedSettingIds, result)
    bindings = await pushLocalChanges(context, callContext, session, bindings, frozenPresetIds, connection, result)
    bindings = await propagateConfirmedDeletes(context, callContext, session, bindings, connection, result)

    await writePresetBindings(context.store, [...bindings, ...reconciled.frozen])
    await writeConnection(context.store, {
      ...(await readConnection(context.store, context.logger) ?? connection),
      status: 'connected',
      lastSyncedAt: new Date().toISOString(),
      lastError: null
    })
    // A per-preset rejection never fails the pass, so without this line a sync that put
    // six presets on hold is indistinguishable in the log from one that did nothing. One
    // summary rather than one line per preset: the per-preset reasons ride in the
    // response and are stored on the binding's hold, which is where the user reads them.
    if (result.failed.length > 0) {
      context.logger.warn(
        `Bambu Cloud sync for workspace ${context.workspaceId} left ${result.failed.length} preset(s) on hold: `
        + result.failed.map((entry) => `${entry.name} (${entry.detail ?? 'no detail'})`).join('; ')
      )
    }
    return result
  } catch (error) {
    if (error instanceof BambuCloudError && error.kind === 'expired') {
      await markConnectionExpired(context.store, connection, error.message)
    }
    throw error
  }
}

/**
 * The user's OWN cloud presets, flattened across the per-type buckets.
 *
 * `public` is skipped deliberately: it is Bambu's bundled catalogue, identical for
 * every account and already present as the slicer image's system presets. Importing it
 * would duplicate hundreds of presets into every workspace's manager.
 */
function collectRemotePresets(list: Awaited<ReturnType<typeof listBambuCloudSettings>>['list']): Array<{
  summary: BambuCloudSettingSummary
  kind: SlicingPresetKind
}> {
  const collected: Array<{ summary: BambuCloudSettingSummary; kind: SlicingPresetKind }> = []
  for (const type of ['print', 'printer', 'filament'] as const) {
    for (const summary of list[type]?.private ?? []) {
      collected.push({ summary, kind: presetKindFromBambuCloudType(type) })
    }
  }
  return collected
}

const REMOTE_LISTING_CACHE_KEY = 'remoteListing'

/** A stored Bambu listing, so a repeat check need not call Bambu again. */
interface CachedRemoteListing {
  at: string
  route: 'bridge' | 'direct'
  remote: Array<{ summary: BambuCloudSettingSummary; kind: SlicingPresetKind }>
}

async function readCachedRemoteListing(
  store: PluginSettingStore,
  maxAgeMs: number
): Promise<{ remote: CachedRemoteListing['remote']; route: 'bridge' | 'direct' } | null> {
  if (maxAgeMs <= 0) return null
  const raw = await store.get(REMOTE_LISTING_CACHE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CachedRemoteListing
    const age = Date.now() - Date.parse(parsed.at)
    if (!Number.isFinite(age) || age > maxAgeMs) return null
    return { remote: parsed.remote, route: parsed.route }
  } catch {
    // A corrupt cache is not worth a failure: fetch a fresh listing instead.
    return null
  }
}

async function fetchRemoteListing(
  context: SyncContext,
  callContext: CallContext,
  session: BambuCloudSession
): Promise<{ remote: CachedRemoteListing['remote']; route: 'bridge' | 'direct' }> {
  const { list, route } = await listBambuCloudSettings(callContext, session)
  const remote = collectRemotePresets(list)
  // Only the user's OWN presets are kept: `collectRemotePresets` already drops Bambu's
  // bundled catalogue, which is ~1800 entries and would make this cache absurd.
  await context.store.set(REMOTE_LISTING_CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), route, remote } satisfies CachedRemoteListing))
  return { remote, route }
}

/** What a sync would do right now, without doing any of it. */
export interface BambuCloudSyncPlan {
  /** Cloud presets whose copy here is missing or older. */
  pullable: PendingDeletionOutcome[]
  /** Local presets with no cloud copy, or edited here since the last sync. */
  pushable: PendingDeletionOutcome[]
  /** Deletions frozen on one side, awaiting a person's answer. */
  pending: PendingDeletionOutcome[]
  /** Bindings this pass parked after a Bambu rejection; reported so they are not invisible. */
  held: PendingDeletionOutcome[]
  route: 'bridge' | 'direct'
}

export function isBambuCloudSyncPlanEmpty(plan: BambuCloudSyncPlan): boolean {
  return plan.pullable.length === 0 && plan.pushable.length === 0 && plan.pending.length === 0
}

/**
 * Decides what is outstanding, WITHOUT fetching a single preset body or writing anything.
 *
 * One `listSettings` call plus local comparison: the per-preset detail reads that make a
 * real sync expensive are exactly the part a "is there anything to do?" question does not
 * need. That is what makes it cheap enough to run on a timer and read on every editor open.
 *
 * **Shared with the sync on purpose.** `runBambuCloudSync` derives its own work from this
 * same function, so the count a user is shown cannot drift from what pressing Sync does.
 * Two implementations of "what is outstanding" is how a preview ends up promising three
 * changes and delivering five.
 */
function planFromState(
  remote: Array<{ summary: BambuCloudSettingSummary; kind: SlicingPresetKind }>,
  presets: StoredSlicingPreset[],
  bindings: BambuPresetBinding[],
  connection: BambuCloudConnection,
  route: 'bridge' | 'direct'
): { plan: BambuCloudSyncPlan; reconciled: ReconcileDeletionsResult; excludedSettingIds: Set<string> } {
  const reconciled = reconcileDeletions(bindings, remote, presets)
  const excludedSettingIds = new Set([
    ...reconciled.frozen.map((binding) => binding.settingId),
    ...connection.ignoredRemoteSettingIds,
    ...connection.pendingDeletes
  ])

  const bySettingId = new Map(reconciled.active.map((binding) => [binding.settingId, binding]))
  const pullable: PendingDeletionOutcome[] = []
  for (const entry of remote) {
    if (excludedSettingIds.has(entry.summary.setting_id)) continue
    const binding = bySettingId.get(entry.summary.setting_id)
    const wanted = shouldPullFromCloud({
      lastSyncedSettingId: binding?.settingId ?? null,
      lastSyncedCloudUpdateTime: binding?.cloudUpdateTime ?? null,
      remoteSettingId: entry.summary.setting_id,
      remoteCloudUpdateTime: parseBambuCloudUpdateTime(entry.summary.update_time)
    })
    if (wanted) {
      pullable.push({
        presetId: binding?.presetId ?? entry.summary.setting_id,
        name: entry.summary.name?.trim() || entry.summary.setting_id,
        kind: entry.kind
      })
    }
  }

  const byPresetId = new Map(reconciled.active.map((binding) => [binding.presetId, binding]))
  const frozenPresetIds = new Set(reconciled.frozen.map((binding) => binding.presetId))
  const quotaBlocked = new Set(connection.quotaBlockedKinds)
  const pushable: PendingDeletionOutcome[] = []
  const held: PendingDeletionOutcome[] = []
  for (const preset of presets) {
    if (frozenPresetIds.has(preset.id)) continue
    const binding = byPresetId.get(preset.id)
    const changedHere = binding ? binding.localUpdatedAt !== preset.updatedAt : true
    if (!changedHere) continue
    if (binding?.hold) {
      held.push({ presetId: preset.id, name: preset.name, kind: preset.kind })
      continue
    }
    // A kind at Bambu's account limit cannot take new presets, so counting them as
    // "outstanding" would show a number that pressing Sync can never clear.
    if (!binding && quotaBlocked.has(preset.kind)) continue
    pushable.push({ presetId: preset.id, name: preset.name, kind: preset.kind })
  }

  return {
    plan: { pullable, pushable, pending: [...reconciled.missingRemotely, ...reconciled.missingLocally], held, route },
    reconciled,
    excludedSettingIds
  }
}

/**
 * Runs the cheap check and records the answer, writing nothing else.
 *
 * "Nothing else" is exact: no preset is created, edited or deleted here, and nothing is
 * sent to Bambu beyond the one listing read. What it DOES persist is bookkeeping: the
 * freeze on a binding whose two sides disagree (that is how a deletion becomes a question
 * a person can answer) and `lastCheck`, which is what lets a surface show the state
 * without making a call of its own.
 */
export async function checkBambuCloudSync(
  context: SyncContext,
  options: {
    /**
     * Reuse a stored Bambu listing younger than this instead of fetching one. 0 forces a
     * fresh fetch. Only the LISTING is reused: see the note on this function.
     */
    maxListingAgeMs?: number
  } = {}
): Promise<BambuCloudSyncPlan> {
  return await workspaceSyncMutex.run(context.workspaceId, async () => {
    const connection = await readConnection(context.store, context.logger)
    if (!connection) throw new BambuCloudError('This workspace is not connected to a Bambu Cloud account.', 'http', 0)
    if (connection.status === 'expired') {
      throw new BambuCloudError('The Bambu Cloud sign-in has expired. Reconnect the account to keep syncing.', 'expired', 401)
    }

    const session: BambuCloudSession = { region: connection.region, accessToken: connection.accessToken }
    const callContext: CallContext = { workspaceId: context.workspaceId, logger: context.logger, signal: context.signal, call: context.call }

    try {
      // The CACHE IS THE LISTING, never the verdict. Bambu's listing is the expensive,
      // rate-limited part; the rest of the answer is local state we already hold. Caching
      // the verdict instead meant editing a preset here showed nothing for ten minutes,
      // a stale answer to a question whose inputs had all changed locally, which reads as
      // the feature being broken. Reusing only the listing keeps Bambu calls just as rare
      // while a local edit or deletion shows up on the very next look.
      const cached = await readCachedRemoteListing(context.store, options.maxListingAgeMs ?? 0)
      const { remote, route } = cached ?? await fetchRemoteListing(context, callContext, session)
      const presets = await listCustomSlicingPresetRecords(context.workspaceId)
      const bindings = await readPresetBindings(context.store)
      const { plan, reconciled } = planFromState(remote, presets, bindings, connection, route)

      await writePresetBindings(context.store, [...reconciled.active, ...reconciled.frozen])
      await writeConnection(context.store, {
        ...(await readConnection(context.store, context.logger) ?? connection),
        status: 'connected',
        lastError: null,
        lastCheck: {
          at: new Date().toISOString(),
          pullable: plan.pullable.length,
          pushable: plan.pushable.length,
          pending: plan.pending.length
        }
      })
      return plan
    } catch (error) {
      if (error instanceof BambuCloudError && error.kind === 'expired') {
        await markConnectionExpired(context.store, connection, error.message)
      }
      throw error
    }
  })
}

interface ReconcileDeletionsResult {
  /** Bindings pull/push may touch this pass. */
  active: BambuPresetBinding[]
  /** Bindings awaiting a person's decision; excluded from pull/push and preserved as-is. */
  frozen: BambuPresetBinding[]
  missingRemotely: PendingDeletionOutcome[]
  missingLocally: PendingDeletionOutcome[]
}

/**
 * Diffs every binding against the current remote listing and local preset table, and
 * decides which of three things happened to it: nothing (both sides still agree),
 * a deletion nobody has answered for yet (exactly one side is gone, FREEZE and ask),
 * or a deletion that already happened everywhere (both sides gone, nothing to ask,
 * just forget the binding).
 *
 * Runs once, before pull and push, so neither of them can see a binding this pass just
 * froze: see the two skip checks in `pullNewerCloudPresets` / `pushLocalChanges` for
 * why that matters (recreating the exact thing the user just deleted).
 *
 * An already-frozen binding is re-checked every pass: if the missing side came back
 * (the user recreated the preset locally with the SAME id, not possible today, but the
 * check costs nothing, or Bambu's listing lagged and the preset reappears), it resumes
 * normal syncing rather than staying stuck waiting for a decision that no longer means
 * anything.
 */
function reconcileDeletions(
  bindings: BambuPresetBinding[],
  remote: Array<{ summary: BambuCloudSettingSummary; kind: SlicingPresetKind }>,
  presets: StoredSlicingPreset[]
): ReconcileDeletionsResult {
  const remoteSettingIds = new Set(remote.map((entry) => entry.summary.setting_id))
  const localPresetsById = new Map(presets.map((preset) => [preset.id, preset]))
  const now = new Date().toISOString()

  const active: BambuPresetBinding[] = []
  const frozen: BambuPresetBinding[] = []
  const missingRemotely: PendingDeletionOutcome[] = []
  const missingLocally: PendingDeletionOutcome[] = []

  for (const binding of bindings) {
    const hasLocal = localPresetsById.has(binding.presetId)
    const hasRemote = remoteSettingIds.has(binding.settingId)

    if (hasLocal && hasRemote) {
      active.push(binding.pendingConfirmation ? { ...binding, pendingConfirmation: null } : binding)
      continue
    }
    if (!hasLocal && !hasRemote) continue

    const kind: 'missingLocally' | 'missingRemotely' = hasRemote ? 'missingLocally' : 'missingRemotely'
    // Preserve the ORIGINAL detection time across passes so the UI can eventually say
    // how long this has been waiting, rather than resetting to "just now" every sync.
    const detectedAt = binding.pendingConfirmation?.kind === kind ? binding.pendingConfirmation.detectedAt : now
    frozen.push({ ...binding, pendingConfirmation: { kind, detectedAt } })

    const outcome: PendingDeletionOutcome = {
      presetId: binding.presetId,
      // `missingLocally`: there is no live local preset to read a name from, so the
      // name recorded on the binding at last sync is all that survives.
      name: localPresetsById.get(binding.presetId)?.name ?? binding.name,
      kind: binding.kind
    }
    if (kind === 'missingLocally') missingLocally.push(outcome)
    else missingRemotely.push(outcome)
  }

  return { active, frozen, missingRemotely, missingLocally }
}

async function pullNewerCloudPresets(
  context: SyncContext,
  callContext: CallContext,
  session: BambuCloudSession,
  remote: Array<{ summary: BambuCloudSettingSummary; kind: SlicingPresetKind }>,
  bindings: BambuPresetBinding[],
  excludedSettingIds: Set<string>,
  result: BambuCloudSyncResult
): Promise<BambuPresetBinding[]> {
  const bySettingId = new Map(bindings.map((binding) => [binding.settingId, binding]))
  const next = [...bindings]

  for (const entry of remote) {
    // Either frozen awaiting a `missingLocally` decision (pulling now would recreate
    // the exact preset the user just deleted here) or explicitly declined into
    // `ignoredRemoteSettingIds` (they already said "leave it there, don't bring it
    // back"). Both mean: do not pull this one.
    if (excludedSettingIds.has(entry.summary.setting_id)) continue

    const binding = bySettingId.get(entry.summary.setting_id)
    const remoteUpdateTime = parseBambuCloudUpdateTime(entry.summary.update_time)
    const wanted = shouldPullFromCloud({
      lastSyncedSettingId: binding?.settingId ?? null,
      lastSyncedCloudUpdateTime: binding?.cloudUpdateTime ?? null,
      remoteSettingId: entry.summary.setting_id,
      remoteCloudUpdateTime: remoteUpdateTime
    })
    if (!wanted) continue

    const name = entry.summary.name?.trim() || entry.summary.setting_id
    try {
      // The listing is metadata only, so the settings themselves cost one call each.
      const detail = await getBambuCloudSetting(callContext, session, entry.summary.setting_id)
      const setting = detail.setting
      if (!setting || Object.keys(setting).length === 0) {
        result.skipped.push({ name, kind: entry.kind, detail: 'Bambu Cloud returned no settings for this preset.' })
        continue
      }

      const record = decodeCloudPresetSetting(setting)
      // `inherits` names the parent preset; keep whatever the cloud says rather than
      // resolving it here, so a parent we do not have surfaces as an unresolved parent
      // in the manager instead of being silently rewritten to something plausible.
      const [written] = await upsertCustomSlicingPresetRecords(context.workspaceId, [{
        id: binding?.presetId,
        kind: entry.kind,
        name,
        content: JSON.stringify(record, null, 2)
      }])
      if (!written) continue

      const updated: BambuPresetBinding = {
        settingId: entry.summary.setting_id,
        presetId: written.id,
        kind: entry.kind,
        name,
        cloudUpdateTime: remoteUpdateTime ?? parseBambuCloudUpdateTime(detail.update_time),
        // Recording what we just wrote is what stops the pull from looking like a
        // local edit on the very next push pass.
        localUpdatedAt: written.updatedAt,
        baseId: detail.base_id?.trim() || null,
        // A successful pull clears a hold: whatever Bambu objected to last time, this
        // preset is demonstrably reachable now.
        hold: null
      }
      replaceBinding(next, updated)
      bySettingId.set(updated.settingId, updated)
      result.pulled.push({ name, kind: entry.kind })
    } catch (error) {
      if (error instanceof BambuCloudError && error.kind === 'expired') throw error
      result.failed.push({ name, kind: entry.kind, detail: describeError(error) })
    }
  }

  return next
}

async function pushLocalChanges(
  context: SyncContext,
  callContext: CallContext,
  session: BambuCloudSession,
  bindings: BambuPresetBinding[],
  frozenPresetIds: Set<string>,
  connection: BambuCloudConnection,
  result: BambuCloudSyncResult
): Promise<BambuPresetBinding[]> {
  // Fetched fresh HERE, after pull has already run: the local-edit check below compares
  // a preset's `updatedAt` against the binding's `localUpdatedAt`, and pull just wrote a
  // new one for anything it pulled: comparing against a pre-pull snapshot would make
  // every just-pulled preset look locally edited and push it straight back up.
  const presets = await listCustomSlicingPresetRecords(context.workspaceId)
  const byPresetId = new Map(bindings.map((binding) => [binding.presetId, binding]))
  const next = [...bindings]
  const quotaBlocked = new Set(connection.quotaBlockedKinds)

  for (const preset of orderParentsFirst(presets)) {
    // Awaiting a decision on `missingRemotely`: the cloud copy is gone and the user
    // hasn't said whether to delete this one too. Pushing now would recreate it in
    // Bambu Cloud under a brand new id before they got to answer.
    if (frozenPresetIds.has(preset.id)) continue

    const binding = byPresetId.get(preset.id)
    if (binding?.hold) {
      // A hold is only cleared by a local edit or a successful pull, so a preset Bambu
      // keeps rejecting is reported once per pass and otherwise left alone.
      if (binding.localUpdatedAt === preset.updatedAt) continue
    }

    const isNew = !binding
    if (isNew && quotaBlocked.has(preset.kind)) {
      result.skipped.push({ name: preset.name, kind: preset.kind, detail: 'The Bambu Cloud account is at its preset limit.' })
      continue
    }
    // Unchanged since the last successful sync: nothing to send. This is the local-edit
    // check, and both sides of it are OUR timestamp, never Bambu's.
    if (!isNew && binding.localUpdatedAt === preset.updatedAt) continue

    const record = parsePresetContent(preset)
    if (!record) {
      result.failed.push({ name: preset.name, kind: preset.kind, detail: 'The stored preset is not valid JSON.' })
      continue
    }

    const parentName = typeof record.inherits === 'string' ? record.inherits.trim() : ''
    const parentBinding = parentName
      ? next.find((candidate) => candidate.kind === preset.kind && presetNameOf(presets, candidate.presetId) === parentName)
      : undefined
    if (parentName && presets.some((candidate) => candidate.kind === preset.kind && candidate.name === parentName) && !parentBinding) {
      // The parent is one of ours and has not reached the cloud yet. Uploading now
      // would bind this preset to no parent at all.
      result.skipped.push({ name: preset.name, kind: preset.kind, detail: `Waiting for its parent preset "${parentName}" to sync first.` })
      continue
    }

    const payload = buildPayload(preset, record, parentBinding?.settingId ?? binding?.baseId ?? '')
    try {
      const detail = isNew
        ? await createBambuCloudSetting(callContext, session, payload)
        : await patchBambuCloudSetting(callContext, session, binding.settingId, payload)

      const settingId = detail.setting_id?.trim() || binding?.settingId
      if (!settingId) {
        result.failed.push({ name: preset.name, kind: preset.kind, detail: 'Bambu Cloud did not return an id for the preset.' })
        continue
      }
      const updated: BambuPresetBinding = {
        settingId,
        presetId: preset.id,
        kind: preset.kind,
        name: preset.name,
        cloudUpdateTime: parseBambuCloudUpdateTime(detail.update_time),
        localUpdatedAt: preset.updatedAt,
        baseId: payload.base_id || null,
        hold: null
      }
      replaceBinding(next, updated)
      byPresetId.set(preset.id, updated)
      ;(isNew ? result.created : result.updated).push({ name: preset.name, kind: preset.kind })
    } catch (error) {
      if (error instanceof BambuCloudError && error.kind === 'expired') throw error
      if (error instanceof BambuCloudError && error.kind === 'quota') {
        // Every further create of this kind will fail the same way, so stop trying and
        // say so rather than spending the rest of the pass being rejected.
        quotaBlocked.add(preset.kind)
        await writeConnection(context.store, { ...connection, quotaBlockedKinds: [...quotaBlocked] })
      }
      const detail = describeError(error)
      if (binding) replaceBinding(next, { ...binding, hold: { reason: detail, at: new Date().toISOString() } })
      result.failed.push({ name: preset.name, kind: preset.kind, detail })
    }
  }

  return next
}

/**
 * Removes cloud presets the user confirmed deleting.
 *
 * Queued rather than deleted inline at request time so a confirmed removal is not lost
 * to a network blip, but never inferred: a preset only lands in this queue when the
 * user explicitly asked for it to be removed from their Bambu account too.
 */
async function propagateConfirmedDeletes(
  context: SyncContext,
  callContext: CallContext,
  session: BambuCloudSession,
  bindings: BambuPresetBinding[],
  connection: BambuCloudConnection,
  result: BambuCloudSyncResult
): Promise<BambuPresetBinding[]> {
  if (connection.pendingDeletes.length === 0) return bindings

  const remaining: string[] = []
  let next = bindings
  for (const settingId of connection.pendingDeletes) {
    try {
      await deleteBambuCloudSetting(callContext, session, settingId)
      next = next.filter((binding) => binding.settingId !== settingId)
      result.deleted.push(settingId)
    } catch (error) {
      if (error instanceof BambuCloudError && error.kind === 'expired') throw error
      remaining.push(settingId)
      result.failed.push({ name: settingId, kind: 'process', detail: describeError(error) })
    }
  }

  const current = await readConnection(context.store, context.logger) ?? connection
  await writeConnection(context.store, { ...current, pendingDeletes: remaining })
  return next
}

export interface ResolvedPendingDeletion {
  kind: 'missingLocally' | 'missingRemotely'
}

/**
 * Answers a deletion `reconcileDeletions` froze. The route (`index.ts`) stays thin,
 * this owns the actual state transition so it can be tested the same way as the rest
 * of the engine, without an HTTP harness.
 *
 * Returns `null` when the preset has no pending decision (already resolved, or never
 * had one); the route turns that into 404. Never throws for that case: "nothing to
 * resolve" is a normal outcome, not a failure.
 */
export async function resolvePendingDeletion(
  workspaceId: string,
  store: PluginSettingStore,
  logger: PluginLogger,
  presetId: string,
  action: 'confirm' | 'decline'
): Promise<ResolvedPendingDeletion | null> {
  return await workspaceSyncMutex.run(workspaceId, () => resolvePendingDeletionLocked(workspaceId, store, logger, presetId, action))
}

async function resolvePendingDeletionLocked(
  workspaceId: string,
  store: PluginSettingStore,
  logger: PluginLogger,
  presetId: string,
  action: 'confirm' | 'decline'
): Promise<ResolvedPendingDeletion | null> {
  const bindings = await readPresetBindings(store)
  const binding = bindings.find((entry) => entry.presetId === presetId)
  if (!binding?.pendingConfirmation) return null

  const { kind } = binding.pendingConfirmation
  if (action === 'confirm') {
    if (kind === 'missingRemotely') {
      // Gone from Bambu Cloud; the user agrees the local copy should go too.
      await deleteCustomSlicingPreset(workspaceId, presetId).catch((error) => {
        // Already gone (a second click, or removed through the ordinary delete flow
        // in the meantime) is not a failure to resolve: the binding still needs
        // clearing either way.
        if (!(error instanceof Error) || error.message !== 'Slicing profile not found') throw error
      })
    } else {
      // Gone here; the user agrees Bambu Cloud's copy should go too. Queued rather
      // than deleted inline so a network blip mid-request can't lose a confirmed
      // delete: the next sync pass drains it via `propagateConfirmedDeletes`.
      const connection = await readConnection(store, logger)
      if (connection) {
        await writeConnection(store, { ...connection, pendingDeletes: [...new Set([...connection.pendingDeletes, binding.settingId])] })
      }
    }
  } else if (kind === 'missingLocally') {
    // Declining "remove from Bambu Cloud too" means "leave it there", not "bring it
    // back here". Without this, the next pull would see an unbound preset Bambu still
    // lists and re-import it: reappearing right after the user deleted it.
    const connection = await readConnection(store, logger)
    if (connection) {
      await writeConnection(store, {
        ...connection,
        ignoredRemoteSettingIds: [...new Set([...connection.ignoredRemoteSettingIds, binding.settingId])]
      })
    }
  }
  // A `missingRemotely` decline needs no further action beyond clearing the binding
  // below: the survivor has no binding, so the next sync treats it as an ordinary new
  // local preset and creates it in Bambu Cloud fresh: the one direction where coming
  // back automatically is the wanted outcome.

  await writePresetBindings(store, bindings.filter((entry) => entry.presetId !== presetId))
  return { kind }
}

/**
 * Presets ordered so a parent is always considered before anything inheriting from it.
 *
 * Depth is counted along the local `inherits` chain; a name that is not one of ours
 * (a system preset) terminates the walk at depth 0. A cycle, which a hand-edited
 * preset can create, stops at the visited set rather than looping forever.
 */
function orderParentsFirst(presets: StoredSlicingPreset[]): StoredSlicingPreset[] {
  const byKindAndName = new Map(presets.map((preset) => [`${preset.kind}:${preset.name}`, preset]))

  const depthOf = (preset: StoredSlicingPreset): number => {
    const visited = new Set<string>()
    let depth = 0
    let current: StoredSlicingPreset | undefined = preset
    while (current) {
      const key = `${current.kind}:${current.name}`
      if (visited.has(key)) break
      visited.add(key)
      const record = parsePresetContent(current)
      const parentName = typeof record?.inherits === 'string' ? record.inherits.trim() : ''
      if (!parentName) break
      current = byKindAndName.get(`${current.kind}:${parentName}`)
      if (current) depth += 1
    }
    return depth
  }

  return [...presets].sort((left, right) => depthOf(left) - depthOf(right))
}

/**
 * The create/update body.
 *
 * `setting` is sent as stored, which is already the diff-against-parent form Bambu
 * expects: a preset that arrived from the cloud was stored from Bambu's own diff, and
 * a BambuStudio user-preset export is a diff too (`inherits` plus the overrides). What
 * must NOT happen is expanding it into a full config, every inherited value would
 * become a local override and the preset would stop tracking its parent.
 */
function buildPayload(preset: StoredSlicingPreset, record: Record<string, unknown>, baseId: string): BambuCloudSettingPayload {
  const setting = encodeCloudPresetSetting(record)
  const filamentId = readFirstString(record.filament_id)
  return {
    type: bambuCloudTypeFromPresetKind(preset.kind),
    name: preset.name,
    version: BAMBU_SLICER_API_VERSION,
    base_id: baseId,
    // Bambu requires `filament_id` only for a ROOT filament preset (no parent); sending
    // it on a child is what makes the server treat the child as its own base.
    ...(preset.kind === 'filament' && !baseId && filamentId ? { filament_id: filamentId } : {}),
    setting
  }
}

function readFirstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim())
    return typeof first === 'string' ? first.trim() : null
  }
  return null
}

function parsePresetContent(preset: StoredSlicingPreset): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(preset.content) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function presetNameOf(presets: StoredSlicingPreset[], presetId: string): string | null {
  return presets.find((preset) => preset.id === presetId)?.name ?? null
}

function replaceBinding(bindings: BambuPresetBinding[], updated: BambuPresetBinding): void {
  const index = bindings.findIndex((binding) => binding.presetId === updated.presetId || binding.settingId === updated.settingId)
  if (index >= 0) bindings[index] = updated
  else bindings.push(updated)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
