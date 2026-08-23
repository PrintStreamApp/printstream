/**
 * Which slicing engines a workspace shows its users.
 *
 * The hosted deployment installs every engine, because its users cannot install
 * one themselves and a project saved by an older Bambu Studio still has to be
 * sliceable. That leaves a picker listing seven versions to a workspace that
 * only ever uses one, so a workspace can hide the ones it does not want to
 * see.
 *
 * **Presentation only, and that is deliberate.** Hiding an engine removes it
 * from the lists a user picks from; it does not refuse a slice that names it.
 * A project can carry a target chosen before the engine was hidden, and a
 * dispatch that suddenly failed with "unknown engine" would be a far worse
 * outcome than a picker showing one row more than someone wanted. Enforcement
 * belongs where an engine is genuinely absent, which the slicer already
 * answers.
 *
 * Stored as an ALLOW list rather than a deny list. A deny list silently adopts
 * every engine added later, the opposite of what a workspace that curated its
 * list was asking for, but an empty or absent record means "everything", so
 * nothing has to be configured for the ordinary case.
 *
 * Counterpart: `apps/api/src/routes/slicing.ts` (`/capabilities`), which is the
 * one place this filter is applied.
 */
import { rootPrisma } from './prisma.js'
import { scopeSettingKeyForWorkspace } from './workspace-settings.js'

const VISIBLE_ENGINES_SETTING_KEY = 'slicing.visibleEngineIds'

/**
 * The ids this workspace shows, or null for "all of them".
 *
 * Null rather than the full list on purpose: the caller does not know the full
 * list, the slicer does, and a workspace that has never chosen must not be
 * pinned to whatever the engine set happened to be on the day it was created.
 */
export async function readVisibleEngineIds(workspaceId: string): Promise<string[] | null> {
  const row = await rootPrisma.setting.findUnique({
    where: { key: scopeSettingKeyForWorkspace(workspaceId, VISIBLE_ENGINES_SETTING_KEY) },
    select: { value: true }
  })
  if (!row) return null
  const parsed = parseVisibleEngineIds(row.value)
  // An empty stored list would hide every engine and leave the workspace unable
  // to slice at all, with no way back except this setting. Treated as "not
  // configured", the same thing the absent row means.
  return parsed && parsed.length > 0 ? parsed : null
}

/** Replaces the choice. An empty list clears it, restoring "show everything". */
export async function writeVisibleEngineIds(workspaceId: string, ids: readonly string[]): Promise<void> {
  const key = scopeSettingKeyForWorkspace(workspaceId, VISIBLE_ENGINES_SETTING_KEY)
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  if (unique.length === 0) {
    await rootPrisma.setting.deleteMany({ where: { key } })
    return
  }
  const value = JSON.stringify(unique)
  await rootPrisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

/**
 * Apply the workspace's choice to what the slicer reported.
 *
 * Never returns an empty list while the slicer has engines: a choice that
 * matches nothing (every chosen engine has since been removed from the
 * deployment) falls back to showing everything, because a workspace that cannot
 * see any engine cannot slice and cannot fix it from the slice dialog either.
 */
export function filterVisibleEngines<T extends { id: string }>(
  targets: readonly T[],
  visibleIds: readonly string[] | null
): T[] {
  if (!visibleIds || visibleIds.length === 0) return [...targets]
  const allowed = new Set(visibleIds)
  const filtered = targets.filter((target) => allowed.has(target.id))
  return filtered.length > 0 ? filtered : [...targets]
}

function parseVisibleEngineIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  } catch {
    return null
  }
}
