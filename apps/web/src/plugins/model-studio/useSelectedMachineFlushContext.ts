/**
 * The flushing dialog's context for the SELECTED printer: resolves that preset through the save
 * target (the resolvers the bake uses) and previews the retarget with
 * `flushContextForSelectedMachine`. While the machine is unresolved, or the host cannot resolve it,
 * the project is read as stored.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ProjectFlushContext } from '@printstream/shared'
import type { EditorSaveTarget } from './lib/editorSaveTarget'
import { flushContextForSelectedMachine } from './lib/flushContextForMachine'

export function useSelectedMachineFlushContext(input: {
  projectSettingsJson: string | null | undefined
  saveTarget: EditorSaveTarget
  /** The printer preset selected in the slice settings; empty while none is. */
  machineProfileId: string | null | undefined
  slicerTargetId: string | null | undefined
}): ProjectFlushContext | null {
  const { saveTarget, machineProfileId } = input
  const slicerTargetId = input.slicerTargetId || null
  const machineQuery = useQuery({
    queryKey: ['editor-flush-machine', machineProfileId, slicerTargetId],
    enabled: Boolean(machineProfileId) && typeof saveTarget.resolveMachine === 'function',
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => (await saveTarget.resolveMachine?.(machineProfileId!, slicerTargetId, signal)) ?? null
  })
  const machine = machineQuery.data ?? null
  return useMemo(
    () => flushContextForSelectedMachine(input.projectSettingsJson, machine),
    [input.projectSettingsJson, machine]
  )
}
