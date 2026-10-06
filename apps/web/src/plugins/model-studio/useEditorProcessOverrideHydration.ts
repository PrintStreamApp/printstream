/**
 * Restores saved object and part process overrides as source scenes arrive.
 * Each baked identity seeds once per editor session. Part additions compose with
 * the concurrent late-plate fill through a functional state update.
 */
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { LibraryThreeMfScene } from '@printstream/shared'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { partSlotKey, type EditorState } from './lib/editorModel'

interface ProcessOverrideHydrationOptions {
  scenesByPlate: ReadonlyMap<number, LibraryThreeMfScene>
  sliceConfigRef: MutableRefObject<SliceSettingsController | undefined>
  stateRef: MutableRefObject<EditorState | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
}

/** Seed per-object and per-part overrides without marking the reopened project dirty. */
export function useEditorProcessOverrideHydration(options: ProcessOverrideHydrationOptions): void {
  const { scenesByPlate, sliceConfigRef, stateRef, setState } = options
  const seededObjectIdsRef = useRef<Set<number>>(new Set())
  const seededPartKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const perObject = sliceConfigRef.current?.perObjectSettings
    if (!perObject || scenesByPlate.size === 0) return
    const current = perObject.value
    const additions: Record<string, Record<string, string | string[]>> = {}
    for (const scene of scenesByPlate.values()) {
      for (const instance of scene.instances) {
        if (!instance.processOverrides) continue
        if (seededObjectIdsRef.current.has(instance.objectId)) continue
        seededObjectIdsRef.current.add(instance.objectId)
        if (current[String(instance.objectId)]) continue
        additions[String(instance.objectId)] = { ...instance.processOverrides }
      }
    }
    if (Object.keys(additions).length > 0) perObject.onChange({ ...current, ...additions })
  }, [scenesByPlate, sliceConfigRef])

  useEffect(() => {
    const current = stateRef.current
    if (scenesByPlate.size === 0 || !current) return
    const additions: Record<string, Record<string, string>> = {}
    for (const scene of scenesByPlate.values()) {
      for (const instance of scene.instances) {
        for (const [partIndex, part] of instance.parts.entries()) {
          if (!part.processOverrides || Object.keys(part.processOverrides).length === 0) continue
          const key = partSlotKey(instance.objectId, partIndex)
          if (seededPartKeysRef.current.has(key)) continue
          seededPartKeysRef.current.add(key)
          if (current.partProcessOverrides?.[key]) continue
          additions[key] = { ...part.processOverrides }
        }
      }
    }
    if (Object.keys(additions).length === 0) return
    setState((prev) => prev
      ? { ...prev, partProcessOverrides: { ...(prev.partProcessOverrides ?? {}), ...additions } }
      : prev)
  }, [scenesByPlate, stateRef, setState])
}
