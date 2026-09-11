/**
 * Removes nozzle assignments recorded by a previous slice before a project is handed to the CLI.
 *
 * BambuStudio treats any `group_id` on a `slice_info.config` filament as live input, even though
 * the sidecar describes an earlier slice. Older files can pair that attribute with no per-plate
 * filament map, selecting an out-of-bounds loader path. The current slice's authoritative nozzle
 * assignment lives in project/model settings and the CLI `--filament-map` argument instead.
 */

const FILAMENT_ELEMENT_PATTERN = /<filament\b[^>]*>/g
const GROUP_ID_ATTRIBUTE_PATTERN = /\s+group_id="[^"]*"/g

/** True when a slice-info filament still carries a previous slice's nozzle group. */
export function sliceInfoCarriesNozzleGroupIds(sliceInfoXml: string): boolean {
  for (const element of sliceInfoXml.match(FILAMENT_ELEMENT_PATTERN) ?? []) {
    if (/\bgroup_id="/.test(element)) return true
  }
  return false
}

/** Remove filament `group_id` attributes while leaving the rest of the document unchanged. */
export function stripSliceInfoNozzleGroupIds(sliceInfoXml: string): string {
  return sliceInfoXml.replace(FILAMENT_ELEMENT_PATTERN, (element) =>
    element.replace(GROUP_ID_ATTRIBUTE_PATTERN, '')
  )
}
