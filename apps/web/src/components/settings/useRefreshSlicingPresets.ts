/** Owns the workspace preset-write refresh boundary, including writes that outlive the manager. */
import { createContext, useContext } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export type SlicingPresetsChanged = () => void | Promise<void>

/** The manager supplies its host's snapshot refresh without teaching individual controls about editors. */
export const SlicingPresetsChangedContext = createContext<SlicingPresetsChanged | undefined>(undefined)

/** Invalidate all catalogue readers and let an explicit host refresh join that same request. */
export function useRefreshSlicingPresets(onChanged?: SlicingPresetsChanged) {
  const queryClient = useQueryClient()
  const managerChanged = useContext(SlicingPresetsChangedContext)
  const notifyChanged = onChanged ?? managerChanged

  return async (): Promise<void> => {
    // Keep the callback captured by the write: a manager can unmount while its POST is pending.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] }),
      notifyChanged?.()
    ])
  }
}
