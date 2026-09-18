/** A visited login page is not a resumable connection. Auth-disabled self-hosted workspaces are. */
export function isNativeConnectionReady(state: {
  ready: boolean
  actorType: string
  selfHosted: boolean
  authEnabled: boolean
  setupRequired: boolean
  hasWorkspace: boolean
}): boolean {
  if (!state.ready || state.setupRequired) return false
  return state.actorType === 'user'
    || (state.selfHosted && !state.authEnabled && state.hasWorkspace)
}
