/**
 * Slot component for `library.overlays` (always mounted at the library page root).
 * Hosts the queue add flow so it survives the file menu closing: a directly-printable
 * request opens the add dialog; an unsliced-3MF request loads the file and runs the
 * slice-then-queue flow.
 *
 * Re-entrancy guard: the dialogs this renders (`SliceFileModal`/`PrintModal`) themselves
 * render the `library.overlays` slot (for the model-studio preview), which re-enters
 * this host. Left unguarded that recurses infinitely and pegs the main thread. The
 * nesting context makes the inner copy render nothing, breaking the loop while still
 * letting the other (model-studio) overlay components in that slot render.
 */
import { createContext, useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LibraryFile } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { QueueItemDialog } from './QueueItemDialog'
import { SliceToQueueFlow } from './SliceToQueueFlow'
import { clearAddToQueueRequest, useAddToQueueRequest } from './libraryAddStore'

const QueueOverlayActiveContext = createContext(false)

export function LibraryAddToQueueHost() {
  const nested = useContext(QueueOverlayActiveContext)
  const request = useAddToQueueRequest()
  if (nested || !request) return null
  return (
    <QueueOverlayActiveContext.Provider value={true}>
      {request.kind === 'direct'
        ? <QueueItemDialog open onClose={clearAddToQueueRequest} fixedFile={{ id: request.id, name: request.name }} />
        : <SliceRequestHost id={request.id} onClose={clearAddToQueueRequest} />}
    </QueueOverlayActiveContext.Provider>
  )
}

/** Loads the full library file (needed by the slicer dialog) before running the slice flow. */
function SliceRequestHost({ id, onClose }: { id: string; onClose: () => void }) {
  const fileQuery = useQuery<{ file: LibraryFile }>({
    queryKey: ['library-file', id],
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${id}`, { signal })
  })
  if (!fileQuery.data) return null
  return <SliceToQueueFlow file={fileQuery.data.file} onClose={onClose} />
}
