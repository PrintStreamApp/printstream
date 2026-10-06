/**
 * Notify the editor when a changed machine makes the rebuilt scene incompatible.
 *
 * The first resolved target is the project's own machine. A later target waits
 * until the new scene is ready and its placement check has settled, so a toast
 * never reports the old bed's warnings against the new machine.
 */
import { useEffect, useRef } from 'react'
import type { SlicingPresetSummary } from '@printstream/shared'
import { machineSwitchWarnings } from '../../lib/machineSwitchWarnings'
import { toast } from '../../lib/toast'
import type { PlacementWarning } from './editorGeometry'

type Inputs = {
  targetPrinterModel: string | undefined
  placementWarnings: readonly PlacementWarning[]
  sceneReady: boolean
  viewportBuilding: boolean
  layerHeight: number | null
  machineProfile: SlicingPresetSummary | null
}

/** Report each machine switch once, after placement reflects the new bed. */
export function useEditorMachineSwitchWarnings({
  targetPrinterModel,
  placementWarnings,
  sceneReady,
  viewportBuilding,
  layerHeight,
  machineProfile
}: Inputs): void {
  const previousTargetModelRef = useRef<string | undefined>(undefined)
  const pendingSwitchModelRef = useRef<string | null>(null)

  useEffect(() => {
    const previous = previousTargetModelRef.current
    previousTargetModelRef.current = targetPrinterModel
    if (previous === undefined || targetPrinterModel === undefined || previous === targetPrinterModel) return
    pendingSwitchModelRef.current = targetPrinterModel
  }, [targetPrinterModel])

  useEffect(() => {
    const model = pendingSwitchModelRef.current
    if (model == null || !sceneReady || viewportBuilding) return
    pendingSwitchModelRef.current = null
    const warnings = machineSwitchWarnings({
      printerModel: model,
      offBedObjectCount: placementWarnings.filter((warning) => warning.offBed).length,
      layerHeight,
      machineProfile
    })
    for (const warning of warnings) toast.warn(warning.message)
  }, [placementWarnings, sceneReady, viewportBuilding, layerHeight, machineProfile])
}
