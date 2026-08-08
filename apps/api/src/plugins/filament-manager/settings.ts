/**
 * Per-workspace settings for the filament-manager plugin. Currently one toggle:
 * `autoAddBambuSpools` (default ON) — whether inserting an RFID-tagged Bambu
 * spool into any AMS slot auto-creates a library spool. Stored in the plugin's
 * workspace-scoped `Setting` store.
 */
import type { PluginSettingStore } from '../../plugin/types.js'

const AUTO_ADD_KEY = 'autoAddBambuSpools'

export async function loadAutoAddBambuSpools(store: PluginSettingStore, workspaceId: string): Promise<boolean> {
  const value = await store.forWorkspace(workspaceId).get(AUTO_ADD_KEY)
  // Default ON: omitting the row means enabled, so the feature works out of the box.
  return value == null ? true : value !== 'false'
}

export async function setAutoAddBambuSpools(store: PluginSettingStore, workspaceId: string, enabled: boolean): Promise<void> {
  if (enabled) {
    // Delete to fall back to the default-on behavior rather than persisting "true".
    await store.forWorkspace(workspaceId).delete(AUTO_ADD_KEY)
  } else {
    await store.forWorkspace(workspaceId).set(AUTO_ADD_KEY, 'false')
  }
}
