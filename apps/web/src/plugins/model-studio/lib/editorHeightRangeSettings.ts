/**
 * Applies process settings to one height band while preserving its inline layer
 * height and material fields. Bambu's band reader requires a layer height, so
 * an absent value falls back to the active process default.
 */
import type { ProcessSettingOverrides } from '@printstream/shared'
import type { EditorHeightRange } from './editorModel'

/** Replace one band's tunable settings, serializing vector values with semicolons. */
export function applyEditorHeightRangeSettings(
  ranges: readonly EditorHeightRange[],
  index: number,
  overrides: ProcessSettingOverrides,
  defaultLayerHeightMm: number
): EditorHeightRange[] {
  const serialized: Record<string, string> = {}
  for (const [key, value] of Object.entries(overrides)) {
    serialized[key] = Array.isArray(value) ? value.join(';') : value
  }
  return ranges.map((range, rangeIndex) => rangeIndex === index
    ? {
        ...range,
        settings: {
          ...serialized,
          layer_height: range.settings.layer_height ?? String(defaultLayerHeightMm),
          extruder: range.settings.extruder ?? '0'
        }
      }
    : range)
}
