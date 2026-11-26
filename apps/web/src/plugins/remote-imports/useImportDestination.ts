/** Owns one pending save confirmation. Unmounting cancels it before any library write. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeModelDestination } from '../../native/bridge'

export function useImportDestination() {
  const [fileName, setFileName] = useState<string | null>(null)
  const active = useRef(true)
  const pending = useRef<((destination: NativeModelDestination | null) => void) | null>(null)

  const finish = useCallback((destination: NativeModelDestination | null) => {
    const resolve = pending.current
    pending.current = null
    setFileName(null)
    resolve?.(destination)
  }, [])

  const choose = useCallback((name: string): Promise<NativeModelDestination | null> => {
    if (!active.current) return Promise.resolve(null)
    pending.current?.(null)
    setFileName(name)
    return new Promise((resolve) => { pending.current = resolve })
  }, [])

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      pending.current?.(null)
      pending.current = null
    }
  }, [])

  return { fileName, choose, finish }
}
