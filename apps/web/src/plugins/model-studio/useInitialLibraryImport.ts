/** Owns the one-shot library import requested by the library's new-project shortcut. */
import { useEffect, useRef } from 'react'

/** Wait for the seeded scene; latch before starting so rerenders and StrictMode cannot import twice.
 * The normal import handler owns progress and errors. Failed imports remain retryable through
 * the editor's library picker, without an automatic retry loop on subsequent scene updates.
 */
export function useInitialLibraryImport({ fileId, ready, importFromLibrary }: {
  fileId?: string
  ready: boolean
  importFromLibrary: (fileId: string) => Promise<void>
}) {
  const started = useRef(false)
  useEffect(() => {
    if (!fileId || !ready || started.current) return
    started.current = true
    void importFromLibrary(fileId)
  }, [fileId, ready, importFromLibrary])
}
