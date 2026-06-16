import { createContext, useContext } from 'react'

export interface RuntimePolicyValue {
  demoMode: boolean
  /**
   * Managed-bridge mode: the server provisions and owns a single bundled
   * bridge, so every bridge-management surface is hidden and connectivity is
   * presented as an internal service rather than a "bridge" the user manages.
   */
  managedBridge: boolean
}

export const runtimePolicyContext = createContext<RuntimePolicyValue>({
  demoMode: false,
  managedBridge: false
})

export function useRuntimePolicy(): RuntimePolicyValue {
  return useContext(runtimePolicyContext)
}