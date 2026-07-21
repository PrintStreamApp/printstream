import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import Alert from '@mui/joy/Alert'
import Button from '@mui/joy/Button'
import Typography from '@mui/joy/Typography'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import type { SxProps } from '@mui/joy/styles/types'
import { apiFetch } from '../../lib/apiClient'
import { extractErrorMessage } from '@printstream/shared'
import { invalidateLibraryQueries } from '../../lib/libraryQueryInvalidation'

/**
 * Notice + one-click Repair for a project whose embedded settings contradict its own machine
 * topology (`needsSettingsRepair` on the library DTO).
 *
 * ADVISORY, never a gate. Slicing is deliberately NOT blocked: a slice that targets a printer
 * re-authors the machine into the temporary copy it hands the engine, and that write sizes the
 * flush matrix correctly, so these projects usually slice fine as they are. What stays wrong is the
 * STORED file — for a download into Bambu Studio, or a slice that re-authors no machine, where it
 * aborts with an opaque `exited with code 139`. So both places a user reaches the project (the
 * editor on open, and the slice dialog) show this, and neither acts on its own: the API rewrites
 * the stored file ONLY on this button, landing the result as a new library version so the previous
 * bytes stay restorable.
 *
 * Counterpart: `POST /api/library/:id/repair-settings` (apps/api `routes/library.ts`), whose
 * `repaired: false` response means the file turned out not to need it — treated as success here,
 * since the flag can be stale on a client that hasn't refreshed.
 */
export function RepairProjectSettingsAlert({ fileId, onRepaired, sx }: {
  fileId: string
  /** Called after a successful repair, once library caches have been invalidated. */
  onRepaired?: () => void
  sx?: SxProps
}): JSX.Element {
  const queryClient = useQueryClient()
  const [repairing, setRepairing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const repair = async (): Promise<void> => {
    setRepairing(true)
    setError(null)
    try {
      await apiFetch(`/api/library/${fileId}/repair-settings`, { method: 'POST' })
      await invalidateLibraryQueries(queryClient)
      onRepaired?.()
    } catch (caught) {
      setError(extractErrorMessage(caught, 'Could not repair this project.'))
    } finally {
      setRepairing(false)
    }
  }

  return (
    <Alert
      variant="soft"
      color="warning"
      startDecorator={<WarningAmberIcon />}
      endDecorator={
        <Button size="sm" variant="solid" color="warning" loading={repairing} onClick={repair}>
          Repair
        </Button>
      }
      sx={[{ alignItems: 'flex-start' }, ...(Array.isArray(sx) ? sx : [sx])]}
    >
      <div>
        <Typography level="title-sm">This project’s saved settings don’t match its printer</Typography>
        <Typography level="body-sm">
          {error ?? 'It was saved for a different printer and its settings weren’t fully updated, which can make slicing fail. Repairing saves a corrected copy as a new version; the current one stays in the file’s history.'}
        </Typography>
      </div>
    </Alert>
  )
}
