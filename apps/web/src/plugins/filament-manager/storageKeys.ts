/**
 * Browser storage keys owned by the filament-manager plugin (CONF-7, D-105; the registry is
 * `lib/browserStorageKeys.ts`). Each spool directory (the page and the two pickers) keeps its whole
 * display state in one JSON preference.
 */
import { defineStorageKey } from '../../lib/browserStorageKeys'

const owner = 'plugin:filament-manager'

export const spoolDirectoryPrefsKey = defineStorageKey({ key: 'printstream.filament.directory', storage: 'local', kind: 'preference', owner })
export const spoolPickerPrefsKey = defineStorageKey({ key: 'printstream.filament.picker', storage: 'local', kind: 'preference', owner })
export const calibrationPickerPrefsKey = defineStorageKey({
  key: 'printstream.filament.calibrationPicker',
  storage: 'local',
  kind: 'preference',
  owner,
  legacyKeys: ['printstream.filament.calibration-picker']
})

/**
 * Where each spool directory (the Filament tab and the two pickers) keeps its state: its preferences
 * key, and its tag filter's area plus the fragment that area's key was built from before keys were
 * declared, so a saved tag selection carries over.
 */
export const SPOOL_DIRECTORIES = {
  page: { prefsKey: spoolDirectoryPrefsKey, tagArea: 'filament', legacyTagArea: 'filament' },
  picker: { prefsKey: spoolPickerPrefsKey, tagArea: 'filament.picker', legacyTagArea: 'printstream.filament.picker' },
  calibrationPicker: {
    prefsKey: calibrationPickerPrefsKey,
    tagArea: 'filament.calibrationPicker',
    legacyTagArea: 'printstream.filament.calibration-picker'
  }
} as const

export type SpoolDirectoryKind = keyof typeof SPOOL_DIRECTORIES
