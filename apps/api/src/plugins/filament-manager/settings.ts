/**
 * Per-tenant settings for the filament-manager plugin. Currently one toggle:
 * `autoAddBambuSpools` (default ON) — whether inserting an RFID-tagged Bambu
 * spool into any AMS slot auto-creates a library spool. Stored in the plugin's
 * tenant-scoped `Setting` store.
 */
import type { PluginSettingStore } from '../../plugin/types.js'

const AUTO_ADD_KEY = 'autoAddBambuSpools'

export async function loadAutoAddBambuSpools(store: PluginSettingStore, tenantId: string): Promise<boolean> {
  const value = await store.forTenant(tenantId).get(AUTO_ADD_KEY)
  // Default ON: omitting the row means enabled, so the feature works out of the box.
  return value == null ? true : value !== 'false'
}

export async function setAutoAddBambuSpools(store: PluginSettingStore, tenantId: string, enabled: boolean): Promise<void> {
  if (enabled) {
    // Delete to fall back to the default-on behavior rather than persisting "true".
    await store.forTenant(tenantId).delete(AUTO_ADD_KEY)
  } else {
    await store.forTenant(tenantId).set(AUTO_ADD_KEY, 'false')
  }
}
