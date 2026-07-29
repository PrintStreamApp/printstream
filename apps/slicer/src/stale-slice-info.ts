/**
 * Drop stale sliced-result nozzle groups from a 3MF's `Metadata/slice_info.config` before the
 * CLI loads it.
 *
 * OWNS: the one prep-time edit to `slice_info.config` (see `prepareInputThreeMf` in `index.ts`,
 * which applies this to every slice, not only the rewriting paths).
 *
 * WHY. `slice_info.config` records what a PREVIOUS slice did. BambuStudio treats one part of it —
 * each `<filament>`'s `group_id`, the logical nozzle that filament was assigned to — as live input
 * on the next load, and its two sources of truth disagree for any project last sliced by an older
 * BambuStudio:
 *
 *   `PartPlate::load_from_3mf_structure` -> `MultiNozzleUtils::load_nozzle_infos_with_compatibility`
 *   takes a backward-compatible path (derive the nozzle list from the machine's `nozzle_diameter`)
 *   ONLY when no filament carries exactly one `group_id`. A single stale `group_id` flips it to
 *   the "trust the file" branch, which then reads `filament_map[filament.id]` — the plate's
 *   `filament_maps` attribute in `model_settings.config`. That attribute is NEWER than the
 *   `group_id` it is paired with, so a file sliced by e.g. BambuStudio 1.10 has the group id and
 *   not the map: an empty `std::vector<int>` indexed at [0], an out-of-bounds read, and SIGSEGV
 *   (exit 139) at load — before any geometry is looked at, on every printer, single- or
 *   dual-nozzle alike.
 *
 * Stripping the attribute is not just the crash guard, it is also the more correct input: the
 * authoritative filament->nozzle assignment for THIS slice is the project's current
 * `filament_nozzle_map`/`filament_map` plus the explicit `--filament-map` argument
 * (`filament-map-args.ts`), never what some earlier slice happened to choose. Nothing else in the
 * file is touched, so the plate's filament COUNT — which the CLI's arrange path reads off
 * `slice_filaments_info.size()` — survives.
 *
 * We only sanitize the copy handed to the CLI. The stored 3MF keeps its group ids on purpose:
 * the shared index parser reads them as the authoritative per-slot nozzle signal for the library
 * and editor UI (`packages/shared/src/three-mf/index-parser.ts`), and the bake keeps them in step
 * when materials are reassigned (`three-mf/bake-documents.ts`).
 */

/** A `<filament …/>` element in `slice_info.config`, the only element that carries `group_id`. */
const FILAMENT_ELEMENT_PATTERN = /<filament\b[^>]*>/g
const GROUP_ID_ATTRIBUTE_PATTERN = /\s+group_id="[^"]*"/g

/**
 * True when any `<filament>` entry still carries a `group_id` — i.e. when this file would take
 * BambuStudio's crashing branch and the prep rewrite is therefore worth doing.
 */
export function sliceInfoCarriesNozzleGroupIds(sliceInfoXml: string): boolean {
  for (const element of sliceInfoXml.match(FILAMENT_ELEMENT_PATTERN) ?? []) {
    if (/\bgroup_id="/.test(element)) return true
  }
  return false
}

/**
 * Remove every `<filament>` `group_id` attribute, leaving the rest of the document byte-identical.
 * Safe to run on a document that has none (returns it unchanged) and on a malformed or empty one.
 */
export function stripSliceInfoNozzleGroupIds(sliceInfoXml: string): string {
  return sliceInfoXml.replace(FILAMENT_ELEMENT_PATTERN, (element) =>
    element.replace(GROUP_ID_ATTRIBUTE_PATTERN, '')
  )
}
