import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import Alert from '@mui/joy/Alert'
import Button from '@mui/joy/Button'
import Typography from '@mui/joy/Typography'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import type { SxProps } from '@mui/joy/styles/types'
import { apiFetch } from '../../lib/apiClient'
import { extractErrorMessage, type ThreeMfSettingsRepairReason } from '@printstream/shared'
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
/**
 * What to SAY, per defect. The two failures have nothing in common from the user's side — one makes
 * slicing die, the other stops Bambu Studio opening the project — so a single sentence covering
 * both was simply wrong for whichever file was in front of them. Ryan opened a project whose
 * variant index was broken and read "it was saved for a different printer", which it was not.
 */
const REPAIR_COPY: Record<ThreeMfSettingsRepairReason, { title: string; body: string }> = {
  flushMatrix: {
    title: 'This project’s saved settings don’t match its printer',
    body: 'It was saved for a different printer and its settings weren’t fully updated, which can make slicing fail.'
  },
  variantIndex: {
    title: 'This project won’t open in Bambu Studio',
    body: 'Its filament settings are missing a value Bambu Studio needs, so Bambu Studio reports an invalid configuration and refuses to open it. Slicing here is unaffected.'
  }
}

/** Both at once: name the worse consequence (unopenable) without hiding the other. */
const REPAIR_COPY_BOTH = {
  title: 'This project’s saved settings need repairing',
  body: 'Its filament settings are missing a value Bambu Studio needs, and its purge settings don’t match its printer — so Bambu Studio won’t open it and slicing can fail.'
}

export function RepairProjectSettingsAlert({ fileId, reasons, onRepaired, sx }: {
  fileId: string
  /**
   * Which invariants the project breaks (`settingsRepairReasons` on the library DTO / 3MF index).
   * Empty or omitted falls back to the flush-matrix wording — the only cause that existed before
   * this was surfaced, so an older cached DTO still reads sensibly.
   */
  reasons?: readonly ThreeMfSettingsRepairReason[]
  /** Called after a successful repair, once library caches have been invalidated. */
  onRepaired?: () => void
  sx?: SxProps
}): JSX.Element {
  const queryClient = useQueryClient()
  const [repairing, setRepairing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copy = reasons && reasons.length > 1
    ? REPAIR_COPY_BOTH
    : REPAIR_COPY[reasons?.[0] ?? 'flushMatrix']

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
        <Typography level="title-sm">{copy.title}</Typography>
        <Typography level="body-sm">
          {error ?? `${copy.body} Repairing saves a corrected copy as a new version; the current one stays in the file’s history.`}
        </Typography>
      </div>
    </Alert>
  )
}
