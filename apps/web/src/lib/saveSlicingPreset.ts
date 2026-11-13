/**
 * Save an edited preset to the workspace: the one request the machine, process and filament
 * dialogs' "Save as preset" / "Update preset" make.
 *
 * Extracted because the three had each written it out, and because a save must also move the
 * preset revision (`slicingPresetRevision.ts`) the moment it succeeds: an "Update preset" keeps the
 * preset's id, so without it the next Slice could reuse a result sliced with the old values.
 *
 * Counterpart: `POST /api/slicing/profiles` in `apps/api/src/routes/slicing.ts`.
 * @throws whatever `apiFetch` throws; the revision moves only on success.
 */
import { apiFetch } from './apiClient'
import { bumpSlicingPresetRevision } from './slicingPresetRevision'

export async function saveSlicingPreset(input: {
  kind: 'machine' | 'process' | 'filament'
  name: string
  /** True updates the existing custom preset of this name in place. */
  overwrite: boolean
  config: Record<string, unknown>
}): Promise<void> {
  await apiFetch('/api/slicing/profiles', {
    method: 'POST',
    body: {
      kind: input.kind,
      fileName: `${input.name}.json`,
      encoding: 'utf8',
      overwrite: input.overwrite,
      content: JSON.stringify(input.config, null, 2)
    }
  })
  bumpSlicingPresetRevision()
}
