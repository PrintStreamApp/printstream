/**
 * Browser storage keys owned by the model-studio plugin (CONF-7, D-105; the registry is
 * `lib/browserStorageKeys.ts`). Former `bambu.` and unprefixed names are listed so saved values
 * carry over. The preview's maximized preference is core's (`lib/storageKeys.ts`), because core's
 * loading placeholder reads it.
 */
import { defineStorageKey } from '../../lib/browserStorageKeys'

const owner = 'plugin:model-studio'

/** A device preference in localStorage, with its former names. */
function preference(key: string, legacyKeys: readonly string[] = []) {
  return defineStorageKey({ key, storage: 'local', kind: 'preference', owner, legacyKeys })
}

export const parameterTableMaximizedKey = preference('printstream.editor.parameterTable.maximized')
export const parameterTableColumnsKey = preference('printstream.editor.parameterTable.columns')
export const editorSidebarWidthKey = preference('printstream.editor.sidebarWidth', ['editor.sidebarWidth'])
export const editorSidebarCollapsedKey = preference('printstream.editor.sidebarCollapsed', ['bambu.editor.sidebarCollapsed'])
export const editorPlateStripCollapsedKey = preference('printstream.editor.plateStripCollapsed', ['bambu.editor.plateStripCollapsed'])
export const previewGcodeStatsOpenKey = preference('printstream.preview.gcodeStatsOpen', ['bambu.preview.gcodeStatsOpen'])
export const previewGcodeViewModeKey = preference('printstream.preview.gcodeViewMode', ['bambu.preview.gcodeViewMode'])
export const previewGcodeShowTravelKey = preference('printstream.preview.gcodeShowTravel', ['bambu.preview.gcodeShowTravel'])
export const previewGcodeMarkersKey = preference('printstream.preview.gcodeMarkers', ['bambu.preview.gcodeMarkers'])
export const previewPlateStripCollapsedKey = preference('printstream.preview.plateStripCollapsed', ['bambu.preview.plateStripCollapsed'])
export const objImportGammaCorrectionKey = preference('printstream.modelStudio.objImportGammaCorrection')

/** Slicing profiles imported on this device: user data with no other copy, so a record. */
export const localSlicingProfilesKey = defineStorageKey({ key: 'printstream.modelStudio.localSlicingProfiles', storage: 'local', kind: 'record', owner })
