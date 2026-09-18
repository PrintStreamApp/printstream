/** Native consent identity, shared by the API and web. The anonymous marker is scope identity, never a credential. */
export interface NativeNotificationIdentity {
  actor: { type: string; userId?: string | null }
  authEnabled: boolean
  runtimePolicy: { selfHosted?: boolean; demoMode?: boolean }
  workspace?: { id: string } | null
}

/** Anonymous devices may enroll only in a non-demo self-hosted workspace with authentication disabled. */
export function nativeNotificationAccount(input: NativeNotificationIdentity | undefined): string | null {
  if (!input) {
    return null
  }

  if (input.actor.type === 'user') {
    return input.actor.userId || null
  }

  const allowsAnonymousDevice = input.actor.type === 'anonymous'
    && input.authEnabled === false
    && input.runtimePolicy.selfHosted === true
    && !input.runtimePolicy.demoMode

  if (!allowsAnonymousDevice || !input.workspace) {
    return null
  }

  return anonymousNotificationAccount(input.workspace.id)
}

/** Reserved marker kept separate from real user IDs; each device still owns an independent native binding. */
export function anonymousNotificationAccount(workspaceId: string): string {
  return `anonymous:${workspaceId}`
}
