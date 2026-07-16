/**
 * Re-export of the shared machine-retarget math. The implementation lives in
 * `@printstream/shared` (`machine-retarget.ts`) so the API's "save as a
 * different printer" flow and this slicer's native cross-model machine switch
 * share one copy. `prepareInputThreeMf` (`index.ts`) calls
 * `retargetProjectSettingsToMachine`/`mergeInheritedMachineProfile` to rewrite
 * an input 3MF authored for printer A onto printer B before slicing — the same
 * rewrite the editor's save path uses, with no CLI `--estimate-mode` round
 * trip. `retargetProjectSettingsToMachine` calls `repairEstimateModeProjectSettings`
 * internally (a legacy name — it reconstructs the target machine's dual-nozzle
 * topology regardless of how the source was produced); it is re-exported only
 * so the topology-repair unit test can exercise it directly. See
 * `machine-switch-guard.ts` and `docs/slicer-cross-model-machine-switch.md`.
 */
export {
  mergeInheritedMachineProfile,
  repairEstimateModeProjectSettings,
  retargetProjectSettingsToMachine
} from '@printstream/shared'
