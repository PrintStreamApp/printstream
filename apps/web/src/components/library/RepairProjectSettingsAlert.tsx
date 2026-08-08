import { Alert, Button, Typography } from '@mui/joy'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineRounded'
import type { SxProps } from '@mui/joy/styles/types'
import type { ThreeMfSettingsRepairReason } from '@printstream/shared'

/**
 * Notice + Repair for a project whose embedded settings contradict its own machine topology
 * (`needsSettingsRepair` on the library DTO / 3MF index).
 *
 * ONE repair model: repairing happens IN THE EDITOR, staged as an undoable edit
 * (`SceneEdit.repairSettings` + the physics restore) that the user then saves — the bake applies
 * the shared `repairs/` implementations, so a repaired file is identical whichever host staged it.
 * A host with an editor session passes `onRepairInEditor` and gets the Repair button; every other
 * surface renders the ADVISORY, which names the real remedy (open the editor and repair there).
 * The print-prep dialog pairs the advisory with a disabled Print: a flagged file is repaired
 * deliberately, never printed through slice-time fix-ups the user never sees.
 */
/**
 * What to SAY, per defect. The failures have nothing in common from the user's side — one makes
 * slicing die, another stops Bambu Studio opening the project — so a single sentence covering
 * all of them was simply wrong for whichever file was in front of them. Ryan opened a project
 * whose variant index was broken and read "it was saved for a different printer", which it was not.
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
  filamentPhysics: {
    title: 'This project is missing its material settings',
    body: 'It names its materials but not their temperatures, flow and cooling, so Bambu Studio shows them as unnamed presets with default settings.'
  },
  filamentIds: {
    title: 'This project’s materials don’t match their presets',
    body: 'One or more materials were changed without their identity being updated, so Bambu Studio shows them as unnamed project presets with default settings instead of the materials you chose. Slicing here is unaffected.'
  },
  // The only one of these that kills the slice before it starts, so the copy says "every slice"
  // rather than "can make slicing fail" — the user has watched it fail repeatedly by the time they
  // read this, and softer wording would read as guesswork.
  inheritsGroup: {
    title: 'This project’s saved settings still list materials it no longer has',
    body: 'Materials were removed from it but a list of their settings was left behind, which crashes the slicing engine as it loads the project. Every slice of this file fails until it’s repaired.'
  },
  // Like inheritsGroup, the consequence is certain rather than possible — the affected objects
  // slice with the wrong material every time — so the copy states it outright.
  objectExtruder: {
    title: 'Some objects in this project aren’t bound to their materials',
    body: 'Objects that were replaced or imported are missing the material binding the slicing engine reads, so it prints them with the first material instead of the one you assigned.'
  }
}

/** Several at once: name the worse consequence (unopenable) without hiding the others. */
const REPAIR_COPY_BOTH = {
  title: 'This project’s saved settings need repairing',
  body: 'Several of its saved settings disagree with each other, which can stop Bambu Studio opening the project or showing the right materials, and can make slicing fail.'
}

export function RepairProjectSettingsAlert({ reasons, archivedVersion, onRepairInEditor, repairingInEditor, repairInEditorError, sx }: {
  /**
   * Which invariants the project breaks (`settingsRepairReasons` on the library DTO / 3MF index).
   * Empty or omitted falls back to the flush-matrix wording — the only cause that existed before
   * this was surfaced, so an older cached DTO still reads sensibly.
   */
  reasons?: readonly ThreeMfSettingsRepairReason[]
  /**
   * The project on screen is an ARCHIVED version, not the file's head. Repairing it means
   * restoring it first — a decision the user should make knowingly — so no Repair button is
   * offered and the advisory names that remedy.
   */
  archivedVersion?: boolean
  /**
   * Stages the in-editor repairs as an EDIT — the byte-level settings repairs, which the bake
   * applies at save time, and the physics restore — and marks the project dirty rather than
   * writing anything. Supplying it is what gives the notice its button; a surface with no editor
   * session (the print-prep dialog) omits it and renders the advisory instead.
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
   * Why the in-editor repair could not fully run — shown in place of the body. The physics half is
   * all-or-nothing, so a slot whose preset does not resolve means those values were not restored,
   * and saying so is the difference between "it did nothing" and "it silently half-worked".
   */
  repairInEditorError?: string | null
  sx?: SxProps
}): JSX.Element {
  const copy = reasons && reasons.length > 1
    ? REPAIR_COPY_BOTH
    : REPAIR_COPY[reasons?.[0] ?? 'flushMatrix']

  // THE repair model: stage as an undoable edit, persist on save — identical for every defect and
  // every host. An archived version is the one deliberate exception: staging + save would mint a
  // new HEAD from old bytes, which is a restore decision the user should make knowingly, so it
  // stays advisory below.
  if (onRepairInEditor && !archivedVersion) {
    // A FAILED attempt changes colour and title, not just the body text. Reported from a real
    // session: a swapped paragraph inside an identically-styled warning is nearly invisible,
    // especially right after a spinner. Danger + its own title makes the outcome legible at a
    // glance, and it persists until the next attempt (or the next edit, which invalidates it).
    const failed = Boolean(repairInEditorError)
    return (
      <Alert
        variant="soft"
        color={failed ? 'danger' : 'warning'}
        startDecorator={failed ? <ErrorOutlineIcon /> : <WarningAmberIcon />}
        endDecorator={
          <Button
            size="sm"
            variant="solid"
            color={failed ? 'danger' : 'warning'}
            loading={repairingInEditor}
            onClick={onRepairInEditor}
          >
            {failed ? 'Try again' : 'Repair'}
          </Button>
        }
        sx={[{ alignItems: 'flex-start' }, ...(Array.isArray(sx) ? sx : [sx])]}
      >
        <div>
          <Typography level="title-sm">{failed ? 'Couldn’t repair this project' : copy.title}</Typography>
          {/* The certainty note is the partial-repair honesty: anything the bake cannot derive
              with certainty is left alone and re-flagged by the saved file's parse. */}
          <Typography level="body-sm">
            {repairInEditorError ?? `${copy.body} Repairing stages the fix as an edit; save to keep it. Anything that can’t be repaired with certainty is flagged again after saving.`}
          </Typography>
        </div>
      </Alert>
    )
  }

  // Advisory: no editor session to stage into. The remedy always points at where repairing
  // actually happens — the editor — rather than offering an action this surface cannot honour.
  const remedy = archivedVersion
    ? 'This is an archived version — the file’s current version may already be repaired. Restore this version first if you want to repair and use it.'
    : reasons?.length && reasons.every((reason) => reason === 'filamentPhysics')
      ? 'Saving this project from the editor writes them back.'
      : 'Open it in the editor and press Repair, then save the project.'
  return (
    <Alert variant="soft" color="warning" startDecorator={<WarningAmberIcon />} sx={[{ alignItems: 'flex-start' }, ...(Array.isArray(sx) ? sx : [sx])]}>
      <div>
        <Typography level="title-sm">{copy.title}</Typography>
        <Typography level="body-sm">{`${copy.body} ${remedy}`}</Typography>
      </div>
    </Alert>
  )
}
