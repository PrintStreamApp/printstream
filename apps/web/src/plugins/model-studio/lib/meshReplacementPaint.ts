/** Paint-state cleanup when an object's mesh is replaced by unrelated triangle topology. */
import type { EditorState } from './editorModel'

type PaintMaps = Pick<EditorState, 'supportPaint' | 'seamPaint' | 'colorPaint' | 'fuzzyPaint'>

/**
 * Drop every triangle annotation for one object and optionally seed colour paint on its new body.
 *
 * Paint keys include triangle indexes, so carrying any channel onto replacement geometry silently
 * annotates unrelated faces. Other objects' maps are retained byte-for-byte. Empty maps are
 * explicit because replacement is an edit that clears the old mesh's saved annotations.
 */
export function paintMapsAfterMeshReplacement(
  state: PaintMaps,
  hostId: number,
  replacementColorPaint?: Record<number, string>
): PaintMaps {
  const prefix = `${hostId}:`
  const withoutHost = (paint: Record<string, Record<number, string>> | undefined) => Object.fromEntries(
    Object.entries(paint ?? {}).filter(([key]) => !key.startsWith(prefix))
  )
  const colorPaint = withoutHost(state.colorPaint)
  if (replacementColorPaint && Object.keys(replacementColorPaint).length > 0) {
    colorPaint[`${hostId}:0`] = replacementColorPaint
  }
  return {
    supportPaint: withoutHost(state.supportPaint),
    seamPaint: withoutHost(state.seamPaint),
    colorPaint,
    fuzzyPaint: withoutHost(state.fuzzyPaint)
  }
}
