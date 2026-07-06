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
 * `<item>` (`setBuildItemsUnprintableXml` in the API), and the 3D editor's per-instance Printable
 * toggle writes the same marker through the scene bake. This module reads that intent back out and
 * maps each unprintable `<item>` to its instance `identify_id` via `model_settings.config` — the
 * value `--skip-objects` keys on — so no 3MF surgery is needed (removing instances corrupts the
 * `<assemble>` cross-references). Real Bambu source projects carry `identify_id`s natively, and the
 * API's scene bake preserves them (minting fresh ones for new instances) so editor-rewritten 3MFs
 * stay skippable too — see `renderArrangedModelSettingsPlates` in the API's three-mf-scene-builder.
 */
import { readZipEntryText } from './zip-io.js'

/**
 * Pure core: given a 3MF's `3D/3dmodel.model` and `Metadata/model_settings.config` XML, return the
 * `identify_id`s of every instance excluded by a `printable="0"` build `<item>`.
 *
 * Granularity: an object's build items appear in instance-id order (the writer's and reader's
 * shared convention), so a mixed object — some items printable, some not, from the editor's
 * per-INSTANCE toggle — skips exactly the toggled instances. An object whose items are ALL
 * unprintable (the dialog's object-level deselection) skips every one of its instances, even
 * when the instance metadata outnumbers the build items. Empty when nothing is excluded.
 */
export function skipObjectIdentifyIdsFromXml(modelXml: string, settingsXml: string): number[] {
  // Per-object item ordinals (=== instance ids) with each item's printability.
  const itemCounts = new Map<number, { total: number; unprintable: number }>()
  const unprintableInstances = new Set<string>()
  for (const item of modelXml.matchAll(/<item\b[^>]*\/>/g)) {
    const objectId = Number(/\bobjectid="(\d+)"/.exec(item[0])?.[1])
    if (!Number.isInteger(objectId)) continue
    const counts = itemCounts.get(objectId) ?? { total: 0, unprintable: 0 }
    if (/\bprintable="0"/.test(item[0])) {
      unprintableInstances.add(`${objectId}:${counts.total}`)
      counts.unprintable += 1
    }
    counts.total += 1
    itemCounts.set(objectId, counts)
  }

  const identifyIds: number[] = []
  for (const instance of settingsXml.matchAll(/<model_instance\b[^>]*>[\s\S]*?<\/model_instance>/g)) {
    const objectId = Number(/object_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    const counts = Number.isInteger(objectId) ? itemCounts.get(objectId) : undefined
    if (!counts || counts.unprintable === 0) continue
    const instanceId = Number(/instance_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    const wholeObjectSkipped = counts.unprintable === counts.total
    if (!wholeObjectSkipped && !unprintableInstances.has(`${objectId}:${instanceId}`)) continue
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
