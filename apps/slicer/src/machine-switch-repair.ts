/**
 * Re-export of the shared machine-retarget math. The implementation moved to
 * `@printstream/shared` (`machine-retarget.ts`) so the API's "save as a different
 * printer" flow and this slicer's estimate-mode topology repair use one copy.
 */
export {
  mergeInheritedMachineProfile,
  repairEstimateModeProjectSettings,
  retargetProjectSettingsToMachine,
  type ProfileRecord
} from '@printstream/shared'
