/** Prepared-slice payload shaping after the browser has already baked the immutable source 3MF. */
import type { SceneEdit } from '@printstream/shared'

/**
 * Remove attachment bytes already embedded in the staged project.
 *
 * Plate thumbnails stay on the request because the API uses them to decorate the sliced output.
 * Project auxiliaries can be tens of megabytes and have no remaining server-side consumer after
 * staging; resending their base64 form would exceed the API's JSON-body limit.
 */
export function sceneEditForPreparedSlice(sceneEdit: SceneEdit): SceneEdit {
  const { projectAuxiliaries: _embeddedProjectAuxiliaries, ...requestEdit } = sceneEdit
  return requestEdit
}
