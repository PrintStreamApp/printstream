/** Owns catalogue refresh after a workspace preset save, across all three preset editors. */
import { saveSlicingPreset, type SaveSlicingPresetInput } from '../../lib/saveSlicingPreset'
import { useRefreshSlicingPresets } from './useRefreshSlicingPresets'

/**
 * Save a preset (`saveSlicingPreset`: the request plus the preset revision bump), then let the
 * dialog publish its result, then refresh the preset lists and the caller's held catalogue.
 * `publish` is synchronous and runs before the refresh, so a refresh that replaces the dialog's
 * source cannot interrupt it mid-apply. A failed save neither publishes nor refreshes.
 */
export function useSaveSlicingPreset(onSaved?: () => void | Promise<void>) {
  const refreshPresets = useRefreshSlicingPresets(onSaved)
  return async (input: SaveSlicingPresetInput, publish?: () => void): Promise<void> => {
    await saveSlicingPreset(input)
    try {
      publish?.()
    } finally {
      await refreshPresets()
    }
  }
}
