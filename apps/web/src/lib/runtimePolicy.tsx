import { createContext, useContext } from 'react'

export interface RuntimePolicyValue {
  demoMode: boolean
}

export const runtimePolicyContext = createContext<RuntimePolicyValue>({
  demoMode: false
})

export function useRuntimePolicy(): RuntimePolicyValue {
  return useContext(runtimePolicyContext)
}