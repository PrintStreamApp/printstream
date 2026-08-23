/**
 * The native app's update surface, re-exported as `@printstream/api/native-update`
 * for the host process in `apps/server` (its control channel and status-file
 * writer). A thin barrel on purpose: the host must reach these through one
 * import site, loaded only AFTER the API's `started` promise resolves: the
 * modules behind it read `env.ts`, which captures the environment at load.
 */
export { getNativeUpdateInfo, refreshNativeUpdateInfo } from './native-update-check.js'
export { applyNativeUpdate, type NativeUpdateApplyResult } from './native-update-apply.js'
