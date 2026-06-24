import { createContext, useContext } from 'react'

export interface RuntimePolicyValue {
  demoMode: boolean
  /**
   * Managed-bridge mode: the server provisions and owns a single bundled
   * bridge, so every bridge-management surface is hidden and connectivity is
   * presented as an internal service rather than a "bridge" the user manages.
   */
  managedBridge: boolean
  /**
   * Self-hosted (open-source) deployment: the cloud-only platform-administration
   * and marketing surfaces are absent, so the shell must not render them even if
   * their private modules happen to be present (a developer running the private
   * tree with `SELF_HOSTED=true`).
   */
  selfHosted: boolean
}

export const runtimePolicyContext = createContext<RuntimePolicyValue>({
  demoMode: false,
  managedBridge: false,
  selfHosted: false
})

export function useRuntimePolicy(): RuntimePolicyValue {
  return useContext(runtimePolicyContext)
}