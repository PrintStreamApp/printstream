/**
 * How a bridge takes updates, as one setting: `BRIDGE_UPDATE_MODE` (CONF-10).
 *
 * - `automatic`: installs a new build by itself as soon as the server has one.
 * - `manual`: waits for "Update bridge" in PrintStream's settings.
 * - `pinned`: never updates, not even when the server pushes one, for running a fixed build.
 *
 * It replaces two booleans, `BRIDGE_AUTO_UPDATE` and `BRIDGE_DISABLE_SELF_UPDATE`, which could also
 * say "automatic and pinned" at once. Self-hosters have the old names in `.env` files and compose
 * files, and the standalone installer wrote them into each machine's config file, so they are read
 * for good (CONF-10's self-hosted exception) and produce a notice naming the replacement. The
 * standalone bridge also rewrites its own config file (`migrateLegacyUpdateSettings`), keeping the
 * old names beside the new one, in agreement, so a rollback to an older build keeps the mode.
 *
 * Pure: callers pass the raw values in and log the notices themselves.
 */
import { z } from 'zod'

export const BRIDGE_UPDATE_MODES = ['automatic', 'manual', 'pinned'] as const
export type BridgeUpdateMode = typeof BRIDGE_UPDATE_MODES[number]

export const bridgeUpdateModeSchema = z.enum(BRIDGE_UPDATE_MODES)

/** The deprecated names, in the order the notices mention them. */
export const LEGACY_AUTO_UPDATE_KEY = 'BRIDGE_AUTO_UPDATE'
export const LEGACY_DISABLE_SELF_UPDATE_KEY = 'BRIDGE_DISABLE_SELF_UPDATE'
export const UPDATE_MODE_KEY = 'BRIDGE_UPDATE_MODE'

/** The update settings as the operator set them; `undefined` means not set. */
export interface BridgeUpdateSettings {
  mode: BridgeUpdateMode | undefined
  legacyAutoUpdate: boolean | undefined
  legacyDisableSelfUpdate: boolean | undefined
}

export interface ResolvedBridgeUpdateMode {
  mode: BridgeUpdateMode
  /** Deprecation and conflict notices to log once at startup; empty when only the new name is used. */
  notices: string[]
}

/**
 * The mode the old pair of settings meant, or `undefined` when neither says anything.
 *
 * Pinned wins over automatic when both are set: the operator who pinned a build asked for it to
 * stay put, and an update they did not expect is the worse surprise.
 */
export function legacyUpdateMode(
  legacyAutoUpdate: boolean | undefined,
  legacyDisableSelfUpdate: boolean | undefined
): BridgeUpdateMode | undefined {
  if (legacyDisableSelfUpdate) return 'pinned'
  if (legacyAutoUpdate === true) return 'automatic'
  if (legacyAutoUpdate === false) return 'manual'
  return undefined
}

/**
 * The old pair of settings that means `mode`, written next to `BRIDGE_UPDATE_MODE` in a standalone
 * install's config file. A bridge rolled back to a build from before the new setting (1.3.22 and
 * earlier) reads only these, and with neither present it would default to automatic, un-pinning a
 * pinned or manual bridge. Keeping them costs nothing: they agree with the new setting, so they
 * produce no notice.
 */
export function legacySettingsForMode(mode: BridgeUpdateMode): Record<typeof LEGACY_AUTO_UPDATE_KEY | typeof LEGACY_DISABLE_SELF_UPDATE_KEY, string> {
  return {
    [LEGACY_AUTO_UPDATE_KEY]: mode === 'automatic' ? 'true' : 'false',
    [LEGACY_DISABLE_SELF_UPDATE_KEY]: mode === 'pinned' ? 'true' : 'false'
  }
}

/** A config file's or environment's spelling of a boolean, as the env module reads it; else unset. */
export function parseLegacyFlag(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  return undefined
}

/**
 * Works out the update mode: the new setting, else what the old names meant, else `defaultMode`.
 *
 * @param defaultMode what this kind of bridge does when nothing is set (automatic for the slim
 *   Docker image and the standalone builds, manual otherwise).
 */
export function resolveBridgeUpdateMode(
  settings: BridgeUpdateSettings,
  defaultMode: BridgeUpdateMode
): ResolvedBridgeUpdateMode {
  const notices: string[] = []
  const legacyNames = [
    settings.legacyAutoUpdate === undefined ? null : LEGACY_AUTO_UPDATE_KEY,
    settings.legacyDisableSelfUpdate === undefined ? null : LEGACY_DISABLE_SELF_UPDATE_KEY
  ].filter((name): name is string => name !== null)

  // The new setting is authoritative. Old names that agree with it are the rollback copy a
  // standalone install keeps (`legacySettingsForMode`); only a contradiction is reported.
  if (settings.mode) {
    // Old names that say nothing on their own (`BRIDGE_DISABLE_SELF_UPDATE=false`) contradict nothing.
    const legacyMode = legacyUpdateMode(settings.legacyAutoUpdate, settings.legacyDisableSelfUpdate)
    const agrees = legacyMode === undefined || legacyMode === settings.mode
    if (legacyNames.length > 0 && !agrees) {
      notices.push(`${legacyNames.join(' and ')} ignored because ${UPDATE_MODE_KEY} is set; remove them.`)
    }
    return { mode: settings.mode, notices }
  }

  if (legacyNames.length === 0) {
    return { mode: defaultMode, notices }
  }

  // An old name that says nothing on its own (`BRIDGE_DISABLE_SELF_UPDATE=false`) leaves the default.
  const mode = legacyUpdateMode(settings.legacyAutoUpdate, settings.legacyDisableSelfUpdate) ?? defaultMode

  if (settings.legacyAutoUpdate === true && settings.legacyDisableSelfUpdate === true) {
    notices.push(
      `${LEGACY_AUTO_UPDATE_KEY}=true and ${LEGACY_DISABLE_SELF_UPDATE_KEY}=true contradict each other; `
        + 'the bridge stays pinned.'
    )
  }
  notices.push(`${legacyNames.join(' and ')} ${legacyNames.length > 1 ? 'are' : 'is'} deprecated; `
    + `set ${UPDATE_MODE_KEY}=${mode} instead.`)
  return { mode, notices }
}
