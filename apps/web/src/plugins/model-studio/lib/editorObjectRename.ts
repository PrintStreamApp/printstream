/**
 * Renames every instance of one editor object without changing its geometry.
 * Baked copies share an object id; staged copies share an import id. The explicit
 * override flag makes the next SceneEdit write the new label to the project.
 */
import type { EditorInstance, EditorPlate } from './editorModel'

/** Return plates with every copy of `target` renamed, leaving other objects untouched. */
export function renameEditorObjectInstances(
  plates: ReadonlyArray<EditorPlate>,
  target: EditorInstance,
  name: string
): EditorPlate[] {
  const sameObject = (instance: EditorInstance): boolean => {
    if (target.source.kind === 'import') {
      return instance.source.kind === 'import' && instance.source.importId === target.source.importId
    }
    return instance.source.kind === 'object' && instance.objectId === target.objectId
  }
  return plates.map((plate) => ({
    ...plate,
    instances: plate.instances.map((instance) =>
      sameObject(instance) ? { ...instance, name, nameOverridden: true } : instance
    )
  }))
}
