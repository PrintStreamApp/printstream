import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Typography } from '@mui/joy'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineRounded'
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
  },
  // Body is the SYMPTOM only; its branch appends the remedy, which differs by whether the host can
  // save (see the `filamentPhysics` branch below).
  filamentPhysics: {
    title: 'This project is missing its material settings',
    body: 'It names its materials but not their temperatures, flow and cooling, so Bambu Studio shows them as unnamed presets with default settings.'
  },
  filamentIds: {
    title: 'This project’s materials don’t match their presets',
    body: 'One or more materials were changed without their identity being updated, so Bambu Studio shows them as unnamed project presets with default settings instead of the materials you chose. Slicing here is unaffected.'
  }
}

/** Both at once: name the worse consequence (unopenable) without hiding the other. */
const REPAIR_COPY_BOTH = {
  title: 'This project’s saved settings need repairing',
  body: 'Several of its saved settings disagree with each other, which can stop Bambu Studio opening the project or showing the right materials, and can make slicing fail.'
}

export function RepairProjectSettingsAlert({ fileId, reasons, onRepaired, onRepairInEditor, repairingInEditor, repairInEditorError, sx }: {
  /**
   * The stored library file to repair through the route. OMITTED for a host with no library file
   * behind the project (the public 3MF editor, which opens a file off the user's disk): the notice
   * still renders, and only the defects that repair WITHOUT the route offer an action.
   */
  fileId?: string
  /**
   * Which invariants the project breaks (`settingsRepairReasons` on the library DTO / 3MF index).
   * Empty or omitted falls back to the flush-matrix wording — the only cause that existed before
   * this was surfaced, so an older cached DTO still reads sensibly.
   */
  reasons?: readonly ThreeMfSettingsRepairReason[]
  /** Called after a successful repair, once library caches have been invalidated. */
  onRepaired?: () => void
  /**
   * Repairs `filamentPhysics` as an in-editor EDIT — it stages the recovered values and marks the
   * project dirty, rather than writing anything. Supplying it is what gives that notice a button.
   *
   * Deliberately not a save: the editor's Save greys out on a project with no unsaved edits, so the
   * notice used to name a remedy the user could not reach; and making the notice itself save would
   * write the user's file (with a destination prompt on a local project) from a button that reads
   * like an in-place correction. As an edit it is also undoable, like everything else here.
   */
  onRepairInEditor?: () => void
  /** Whether that repair is resolving presets, so the button can show it (the caller owns it). */
  repairingInEditor?: boolean
  /**
   * Why the in-editor repair could not run — shown in place of the body. It is all-or-nothing, so a
   * slot whose preset does not resolve means nothing was changed, and saying so is the difference
   * between "it did nothing" and "it silently half-worked".
   */
  repairInEditorError?: string | null
  sx?: SxProps
}): JSX.Element {
  const queryClient = useQueryClient()
  const [repairing, setRepairing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Slot numbers a completed repair could not resolve, so the outcome can be reported honestly. */
  const [partial, setPartial] = useState<number[] | null>(null)
  const copy = reasons && reasons.length > 1
    ? REPAIR_COPY_BOTH
    : REPAIR_COPY[reasons?.[0] ?? 'flushMatrix']

  const repair = async (): Promise<void> => {
    if (!fileId) return
    setRepairing(true)
    setError(null)
    try {
      const result = await apiFetch<{ repaired: boolean; unresolvedSlots?: number[] }>(
        `/api/library/${fileId}/repair-settings`,
        { method: 'POST' }
      )
      await invalidateLibraryQueries(queryClient)
      // A PARTIAL repair must say so instead of closing silently: a slot whose preset matches no
      // known material keeps the identity it had, so the project is improved but not clean, and a
      // user told nothing would reasonably assume it was. Stays on screen rather than handing the
      // caller `onRepaired` (which typically closes the surface).
      const unresolved = result.unresolvedSlots ?? []
      if (unresolved.length > 0) {
        setPartial(unresolved)
        return
      }
      onRepaired?.()
    } catch (caught) {
      setError(extractErrorMessage(caught, 'Could not repair this project.'))
    } finally {
      setRepairing(false)
    }
  }

  // Repaired IN THE EDITOR rather than by the repair route: the values are recovered from the
  // resolved presets and staged as an edit, which the user then saves. Only when it is the ONLY
  // defect — mixed with a route-repairable one, the route's button still has work to do and runs
  // first.
  if (reasons?.length === 1 && reasons[0] === 'filamentPhysics') {
    // A FAILED attempt changes colour and title, not just the body text. Reported from a real
    // session: the reason "isn't staying on screen long enough to see, and it's hard to tell the
    // message even changed" — because a swapped paragraph inside an identically-styled warning is
    // nearly invisible, especially right after a spinner. Danger + its own title makes the outcome
    // legible at a glance, and it persists until the next attempt.
    const failed = Boolean(repairInEditorError)
    return (
      <Alert
        variant="soft"
        color={failed ? 'danger' : 'warning'}
        startDecorator={failed ? <ErrorOutlineIcon /> : <WarningAmberIcon />}
        endDecorator={onRepairInEditor
          ? (
            <Button
              size="sm"
              variant="solid"
              color={failed ? 'danger' : 'warning'}
              loading={repairingInEditor}
              onClick={onRepairInEditor}
            >
              {failed ? 'Try again' : 'Repair'}
            </Button>
          )
          : undefined}
        sx={[{ alignItems: 'flex-start' }, ...(Array.isArray(sx) ? sx : [sx])]}
      >
        <div>
          <Typography level="title-sm">
            {failed ? 'Couldn’t repair this project' : REPAIR_COPY.filamentPhysics.title}
          </Typography>
          {/* Only promise the button's behaviour when there IS a button; a host without one (the
              slice dialog) would otherwise point at an action it does not offer. */}
          <Typography level="body-sm">
            {repairInEditorError ?? `${REPAIR_COPY.filamentPhysics.body} ${onRepairInEditor
              ? 'Repairing restores them; save to keep the change.'
              : 'Saving this project writes them back.'} Slicing here is unaffected.`}
          </Typography>
        </div>
      </Alert>
    )
  }

  if (partial) {
    const slots = partial.length === 1 ? `material ${partial[0]}` : `materials ${partial.join(', ')}`
    return (
      <Alert variant="soft" color="warning" startDecorator={<WarningAmberIcon />} sx={[{ alignItems: 'flex-start' }, ...(Array.isArray(sx) ? sx : [sx])]}>
        <div>
          <Typography level="title-sm">Repaired, but {slots} still need attention</Typography>
          <Typography level="body-sm">
            {`Their presets aren’t ones we recognise, so we left them as they were rather than guessing. Pick those materials again and save to finish the repair.`}
          </Typography>
        </div>
      </Alert>
    )
  }

  // No stored file to repair (the public editor opens off the user's disk), so the notice is
  // advisory: still worth telling them the file is broken, but the route's button would have
  // nothing to POST to. Deliberately not offering the save here — these defects are not the ones
  // saving fixes, and a button that silently under-delivers is worse than none.
  if (!fileId) {
    return (
      <Alert variant="soft" color="warning" startDecorator={<WarningAmberIcon />} sx={[{ alignItems: 'flex-start' }, ...(Array.isArray(sx) ? sx : [sx])]}>
        <div>
          <Typography level="title-sm">{copy.title}</Typography>
          <Typography level="body-sm">{`${copy.body} Open it from your library to repair it.`}</Typography>
        </div>
      </Alert>
    )
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
