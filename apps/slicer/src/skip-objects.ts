/**
 * Translate a slice-ready 3MF's "not printable" objects into BambuStudio's `--skip-objects` flag.
 *
 * BambuStudio's CLI excludes objects from a plate's slice ONLY via the
 * `--skip-objects "<identify_id,…>"` command-line flag — keyed on each instance's `identify_id`
 * (which the loader stores as `loaded_id`). It does NOT honor the build item's `printable="0"`
 * attribute, nor a `skip_objects` value embedded in the project config. (Verified against the
 * bundled CLI: marking the build items unprintable slices every object; passing the identify_ids
 * via `--skip-objects` slices only the kept ones.)
 *
 * The print/slice dialog's per-object selection expresses exclusion as `printable="0"` on the build
 * `<item>` (`setBuildItemsUnprintableXml` in the API). This module reads that intent back out and
 * maps each unprintable `objectid` to its instance `identify_id`(s) via `model_settings.config` — the
 * value `--skip-objects` keys on — so no 3MF surgery is needed (removing instances corrupts the
 * `<assemble>` cross-references). This requires the 3MF's `<model_instance>` blocks to carry
 * `identify_id`s, which real Bambu source projects do. (The 3D editor's per-INSTANCE Printable toggle
 * also writes `printable="0"`, but its rebuilt 3MF omits `identify_id`s and skips per instance rather
 * than per object, so honoring it through this path is a separate follow-up.)
 */
import { readZipEntryText } from './zip-io.js'

/**
 * Pure core: given a 3MF's `3D/3dmodel.model` and `Metadata/model_settings.config` XML, return the
 * `identify_id`s of every object whose build `<item>` is `printable="0"`. An object can have several
 * instances (each its own identify_id) — all are skipped. Empty when nothing is excluded.
 */
export function skipObjectIdentifyIdsFromXml(modelXml: string, settingsXml: string): number[] {
  const unprintableObjectIds = new Set<number>()
  for (const item of modelXml.matchAll(/<item\b[^>]*\/>/g)) {
    if (!/\bprintable="0"/.test(item[0])) continue
    const objectId = Number(/\bobjectid="(\d+)"/.exec(item[0])?.[1])
    if (Number.isInteger(objectId)) unprintableObjectIds.add(objectId)
  }
  if (unprintableObjectIds.size === 0) return []

  const identifyIds: number[] = []
  for (const instance of settingsXml.matchAll(/<model_instance\b[^>]*>[\s\S]*?<\/model_instance>/g)) {
    const objectId = Number(/object_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    if (!unprintableObjectIds.has(objectId)) continue
    const identifyId = Number(/identify_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    if (Number.isInteger(identifyId)) identifyIds.push(identifyId)
  }
  return identifyIds
}

/**
 * Returns the `identify_id`s to pass to `--skip-objects` for the 3MF at `threeMfPath`. Reads the two
 * relevant entries (tolerating their absence) and delegates to {@link skipObjectIdentifyIdsFromXml}.
 */
export async function deriveSkipObjectIdentifyIds(threeMfPath: string): Promise<number[]> {
  const [modelXml, settingsXml] = await Promise.all([
    readZipEntryText(threeMfPath, '3D/3dmodel.model').catch(() => ''),
    readZipEntryText(threeMfPath, 'Metadata/model_settings.config').catch(() => '')
  ])
  return skipObjectIdentifyIdsFromXml(modelXml, settingsXml)
}

/** Build the `--skip-objects "<id,…>"` argv (empty when nothing to skip). */
export function buildSkipObjectsArgs(identifyIds: readonly number[]): string[] {
  return identifyIds.length > 0 ? ['--skip-objects', identifyIds.join(',')] : []
}
