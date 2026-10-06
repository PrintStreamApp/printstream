/**
 * Render the ordered 3MF build/model-settings instance documents.
 *
 * BambuStudio assigns object ordinals from build-item order, while PrintStream
 * reopens sidebar order from model settings. Both writers use the same grouping
 * so those two documents cannot disagree. Source identify ids survive saves;
 * new instances receive ids above the source maximum for CLI object skipping.
 */
import type { SceneEdit } from '../slicing.js'
import { authoredPlateMetadata, preservedPlateMetadata, type PlateMetadataEntry } from './plate-metadata.js'
import { escapeXmlAttribute } from './xml-write.js'

export interface ArrangedInstance {
  objectId: number
  instanceId: number
  plateIndex: number
  /** Global build-item transform (plate-grid origin re-added). */
  transform: number[]
  /** BambuStudio "Printable" flag; false → write `printable="0"` (greyed, excluded from slice). */
  printable?: boolean
}

/**
 * Instances grouped by object, objects in first-appearance order, each object's instances by
 * instance id.
 *
 * THE ORDER OF THE OBJECTS HERE IS THE ORDER BAMBUSTUDIO DISPLAYS. Its importer creates one
 * `ModelObject` the first time a build `<item>` names an id and only adds instances afterwards
 * (`bbs_3mf.cpp` `_create_object_instance`), and its object list, its plate tree and every
 * position-keyed sidecar walk that same vector. So this is how the editor's sidebar order becomes
 * portable: `arranged` follows `SceneEdit.instances`, which is the sidebar.
 *
 * Grouping is also what `parseRootBuildItemTransforms` relies on to index items back to instances,
 * and it is applied to `<model_instance>` through the SAME function so the two documents cannot
 * drift into disagreeing about which object comes first.
 */
export function groupArrangedByObject(arranged: readonly ArrangedInstance[]): ArrangedInstance[] {
  const byObject = new Map<number, ArrangedInstance[]>()
  for (const instance of arranged) {
    const list = byObject.get(instance.objectId) ?? []
    list.push(instance)
    byObject.set(instance.objectId, list)
  }
  // Sorted in place: the arrays are this function's own, and nothing else holds a reference.
  return [...byObject.values()].flatMap((list) => list.sort((left, right) => left.instanceId - right.instanceId))
}

/**
 * Instance `identify_id`s parsed from a source `model_settings.config`, keyed
 * `"<object_id>:<instance_id>"`, plus the highest id seen (0 when there are none).
 * The bake preserves a returning instance's id and allocates fresh ones above `maxId`.
 */
interface ModelSettingsIdentifyIds {
  byInstance: Map<string, number>
  maxId: number
}

/**
 * Read every `model_instance`'s `identify_id` out of a `model_settings.config`. The id is
 * BambuStudio's per-instance handle (`loaded_id` in the engine), the ONLY key the CLI's
 * `--skip-objects` flag accepts, so the bake must carry it through (or mint one) for the
 * per-object/instance "Printable" exclusion to be enforceable on the rewritten file.
 */
export function parseModelSettingsIdentifyIds(modelSettingsXml: string): ModelSettingsIdentifyIds {
  const byInstance = new Map<string, number>()
  let maxId = 0
  for (const instance of modelSettingsXml.matchAll(/<model_instance\b[^>]*>[\s\S]*?<\/model_instance>/g)) {
    const objectId = Number(/object_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    const instanceId = Number(/instance_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    const identifyId = Number(/identify_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    if (!Number.isInteger(identifyId)) continue
    maxId = Math.max(maxId, identifyId)
    if (Number.isInteger(objectId) && Number.isInteger(instanceId)) {
      byInstance.set(`${objectId}:${instanceId}`, identifyId)
    }
  }
  return { byInstance, maxId }
}

export function renderArrangedModelSettingsPlates(
  arranged: ArrangedInstance[],
  plates: SceneEdit['plates'],
  sourceIdentifyIds: ModelSettingsIdentifyIds,
  sourcePlates: ReadonlyMap<number, PlateMetadataEntry[]>,
  filamentSetStable: boolean,
  allowBedType: boolean
): string {
  const instancesByPlate = new Map<number, ArrangedInstance[]>()
  // Grouped by object through the SAME function the build items use. BambuStudio ignores this
  // order (it reads `<model_instance>` into a map keyed by object id, and writes its own from a
  // `std::set<std::pair<int,int>>`, which is sorted by object) but OUR scene parser seeds the
  // editor's sidebar from it, so writing it ungrouped is how a saved project reopened with an
  // object's copies split around another object, disagreeing with both the build items and
  // BambuStudio about which object comes first.
  for (const instance of groupArrangedByObject(arranged)) {
    const list = instancesByPlate.get(instance.plateIndex) ?? []
    list.push(instance)
    instancesByPlate.set(instance.plateIndex, list)
  }
  // Every instance carries an identify_id: a returning (objectId, instanceId) keeps the
  // source's, new/duplicated instances get fresh ids above the source's maximum. Without
  // one the CLI assigns its own loaded_id at load time, which the slicer service cannot
  // predict, making printable="0" instances impossible to translate into --skip-objects.
  let nextIdentifyId = sourceIdentifyIds.maxId + 1
  const identifyIdFor = (instance: ArrangedInstance): number => {
    const preserved = sourceIdentifyIds.byInstance.get(`${instance.objectId}:${instance.instanceId}`)
    if (preserved != null) return preserved
    const allocated = nextIdentifyId
    nextIdentifyId += 1
    return allocated
  }
  const ordered = [...plates].sort((left, right) => left.index - right.index)
  const blocks = ordered.map((plate) => {
    const lines = [`  <plate>`, `    <metadata key="plater_id" value="${plate.index}"/>`]
    if (plate.name) lines.push(`    <metadata key="plater_name" value="${escapeXmlAttribute(plate.name)}"/>`)
    // What the edit itself says about this plate: bed type, print sequence, vase mode, lock.
    const authored = authoredPlateMetadata(plate, { allowBedType })
    // Everything else the SceneEdit cannot express, carried from the source block. Without this the
    // re-render below silently discarded the plate's print sequence, vase mode and nozzle grouping
    // on every save (`plate-metadata.ts` has the policy and the reasoning). `rawValue` is re-emitted
    // unescaped because it is either the source's escaped text or escaped by the author step.
    // Keyed on the plate's SOURCE number, never its new one. `plate.index` is a position the
    // editor renumbers on every add, delete and reorder, so looking the source block up by it hands
    // a deleted plate's bed type and vase mode to whichever plate took its number, which is the
    // exact misattribution this carry exists to prevent. Falls back to the position only when the
    // edit does not say, which is an older client whose plates cannot have moved through it.
    const sourcePlateNumber = plate.sourceIndex ?? plate.index
    for (const carried of preservedPlateMetadata(sourcePlates.get(sourcePlateNumber), filamentSetStable, authored.keys)) {
      lines.push(`    <metadata key="${carried.key}" value="${carried.rawValue}"/>`)
    }
    for (const entry of authored.entries) {
      lines.push(`    <metadata key="${entry.key}" value="${entry.rawValue}"/>`)
    }
    for (const instance of instancesByPlate.get(plate.index) ?? []) {
      lines.push(
        `    <model_instance>`,
        `      <metadata key="object_id" value="${instance.objectId}"/>`,
        `      <metadata key="instance_id" value="${instance.instanceId}"/>`,
        `      <metadata key="identify_id" value="${identifyIdFor(instance)}"/>`,
        `    </model_instance>`
      )
    }
    lines.push(`  </plate>`)
    return lines.join('\n')
  })
  return blocks.join('\n')
}

export function replaceModelSettingsPlates(xml: string, platesXml: string): string {
  // No leading `[ \t]*` indentation trim: it made the scan quadratic on
  // whitespace-heavy uploads, and any orphaned indentation is inert in XML.
  const withoutPlates = xml.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>\n?/g, '')
  const insertion = platesXml ? `${platesXml}\n` : ''
  if (/<\/config>/.test(withoutPlates)) {
    return withoutPlates.replace(/<\/config>/, `${insertion}</config>`)
  }
  return `${withoutPlates.trimEnd()}\n${insertion}`
}
