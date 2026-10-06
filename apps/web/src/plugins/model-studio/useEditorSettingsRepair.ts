/**
 * Stages project-settings repairs as undoable editor state, including filament physics.
 * Resolving physics is all-or-none because the saved 3MF arrays are positional. Neither
 * action writes a file; the editor's normal save or slice bake consumes the staged state.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ThreeMfSettingsRepairReason } from '@printstream/shared'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import type { FilamentConfigResolver } from '../../components/library/FilamentSettingsDialog'
import { resolvableMaterialProfileId } from '../../lib/slicingPresetMatching'
import type { EditorState } from './lib/editorModel'
import type { EditorProjectSource } from './lib/editorProjectSource'
import { filamentPhysicsFromResolution, sourceFilamentSlotId, type RepairedFilamentPreset } from './lib/filamentConfigAuthoring'

type Options = {
  state: EditorState | null
  setState: Dispatch<SetStateAction<EditorState | null>>
  stateRef: MutableRefObject<EditorState | null>
  sliceConfigRef: MutableRefObject<SliceSettingsController | undefined>
  resolveFilamentConfig?: FilamentConfigResolver
  baseFileId: string | null
  projectSource: EditorProjectSource
  settingsRepairReasons: readonly ThreeMfSettingsRepairReason[]
  recordHistoryRef: MutableRefObject<() => void>
}

/** Keep the repair notice, undo checkpoint, and project-bound pins together. */
export function useEditorSettingsRepair({
  state,
  setState,
  stateRef,
  sliceConfigRef,
  resolveFilamentConfig,
  baseFileId,
  projectSource,
  settingsRepairReasons,
  recordHistoryRef
}: Options) {
  const [repairingPhysics, setRepairingPhysics] = useState(false)
  const [physicsRepairError, setPhysicsRepairError] = useState<string | null>(null)
  const skipOwnStateErrorClearRef = useRef(false)
  const currentProjectRef = useRef({ projectSource, baseFileId })
  currentProjectRef.current = { projectSource, baseFileId }

  // An edit or undo invalidates the last failure, while a repair's own asynchronous miss
  // must survive its staged byte-repair state update, even if preset resolution finishes
  // before React flushes that update.
  useEffect(() => {
    if (skipOwnStateErrorClearRef.current) {
      skipOwnStateErrorClearRef.current = false
      return
    }
    setPhysicsRepairError(null)
  }, [state])

  // The public editor reuses this component for another local file. Old repair pins must
  // never suppress the new project's warning.
  useEffect(() => {
    setRepairingPhysics(false)
    setPhysicsRepairError(null)
    setState((previous) => (previous?.repairedFilamentConfigs || previous?.settingsRepairStaged
      ? { ...previous, repairedFilamentConfigs: undefined, settingsRepairStaged: undefined }
      : previous))
  }, [projectSource, baseFileId, setState])

  /** Resolve every material slot before recording one undoable physics repair. */
  const repairFilamentPhysics = useCallback(async (otherRepairsStaged: boolean) => {
    const controller = sliceConfigRef.current
    if (!resolveFilamentConfig || !controller) return

    setRepairingPhysics(true)
    setPhysicsRepairError(null)
    const projectStillOpen = () => currentProjectRef.current.projectSource === projectSource
      && currentProjectRef.current.baseFileId === baseFileId
    try {
      const resolved: Record<number, RepairedFilamentPreset> = {}
      const unresolved: number[] = []
      for (const [position, slot] of controller.projectFilaments.entries()) {
        const optionId = controller.filamentMaterialOptionIds[slot.projectFilamentId]
        const profileId = resolvableMaterialProfileId(controller.materialOptions.find((option) => option.id === optionId))
        if (!profileId) {
          unresolved.push(slot.projectFilamentId)
          continue
        }

        try {
          const response = await resolveFilamentConfig({
            filamentProfileId: profileId,
            targetId: controller.selectedSlicerTargetId || null,
            sourceFileId: baseFileId,
            projectFilamentId: sourceFilamentSlotId(controller.desiredFilaments?.[position]?.sourceIndex, slot.projectFilamentId)
          })
          // A project preset can resolve to its own empty slot. Read its installed baseline.
          const physics = filamentPhysicsFromResolution(response)
          if (physics) {
            resolved[slot.projectFilamentId] = {
              config: physics,
              // A user preset's parent must accompany its values or Studio reopens it as a copy.
              ...(response.presetInherits === undefined
                ? {}
                : { inherits: response.presetInherits, changedKeys: response.presetChangedKeys ?? [] })
            }
          } else {
            unresolved.push(slot.projectFilamentId)
          }
        } catch {
          // A host unable to resolve this preset kind reports that material as a miss.
          unresolved.push(slot.projectFilamentId)
        }
        // A local file switch must not keep resolving or pin the old file's preset in the new one.
        if (!projectStillOpen()) return
      }

      if (unresolved.length > 0 || Object.keys(resolved).length === 0) {
        const one = unresolved.length === 1
        const slots = one ? `Material ${unresolved[0]}` : `Materials ${unresolved.join(', ')}`
        const stagedNote = otherRepairsStaged ? ' The other repairs are staged; save to keep them.' : ''
        setPhysicsRepairError(unresolved.length > 0
          ? `${slots} didn\u2019t match a known preset, so ${one ? 'its' : 'their'} settings weren\u2019t restored. Pick ${one ? 'it' : 'them'} again, then repair.${stagedNote}`
          : `No materials matched a known preset, so their settings weren\u2019t restored.${stagedNote}`)
        return
      }

      // One checkpoint for the entire resolved set. A partial set must never be baked.
      recordHistoryRef.current?.()
      setState((previous) => (previous ? { ...previous, repairedFilamentConfigs: resolved } : previous))
    } finally {
      if (projectStillOpen()) setRepairingPhysics(false)
    }
  }, [sliceConfigRef, resolveFilamentConfig, baseFileId, projectSource, recordHistoryRef, setState])

  /**
   * Stage byte-level repairs once, including across a retry after a physics miss.
   * These repairs can decline an ambiguous source without throwing; the cached reason list
   * cannot report repairability yet (issue 101), so a notice may return after save.
   */
  const handleRepairInEditor = useCallback(async () => {
    const stageSettings = !stateRef.current?.settingsRepairStaged
      && settingsRepairReasons.some((reason) => reason !== 'filamentPhysics')
    if (stageSettings) {
      recordHistoryRef.current?.()
      setState((previous) => {
        if (!previous) return previous
        skipOwnStateErrorClearRef.current = true
        return { ...previous, settingsRepairStaged: true }
      })
    }

    if (settingsRepairReasons.includes('filamentPhysics')) {
      await repairFilamentPhysics(stageSettings)
    }
  }, [stateRef, settingsRepairReasons, recordHistoryRef, setState, repairFilamentPhysics])

  return { repairingPhysics, physicsRepairError, handleRepairInEditor }
}
