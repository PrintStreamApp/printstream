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
 * (`SceneEdit.repairSettings` + the physics restore) that the user then saves: the bake applies
 * the shared `repairs/` implementations, so a repaired file is identical whichever host staged it.
 * A host with an editor session passes `onRepairInEditor` and gets the Repair button; every other
 * surface renders the ADVISORY, which names the real remedy (open the editor and repair there).
 * The print-prep dialog pairs the advisory with a disabled Print: a flagged file is repaired
 * deliberately, never printed through slice-time fix-ups the user never sees.
 */
/**
 * What to SAY, per defect.
 *
 * TWO RULES, both learned from copy that failed here. Say what it means for the USER, not what is
 * wrong with the file: nobody outside this codebase knows what a variant index or a material
 * binding is, and naming the mechanism spends the reader's attention before reaching the part they
 * can act on. And say it per DEFECT: these failures have nothing in common from the user's side
 * (one kills every slice, another only affects opening the file in Bambu Studio), so one sentence
 * covering all of them was wrong for whichever file was in front of them. Ryan opened a project
 * whose variant index was broken and read "it was saved for a different printer", which it was not.
 *
 * Shape: the title is the symptom, the body is the consequence, and the remedy is added once by the
 * component rather than repeated in every entry. Keep the body to one sentence where the
 * consequence allows it.
 */
const REPAIR_COPY: Record<ThreeMfSettingsRepairReason, { title: string; body: string }> = {
  flushMatrix: {
    title: 'These settings are left over from a different printer',
    body: 'Slicing can fail until this is repaired.'
  },
  variantIndex: {
    title: 'Bambu Studio can’t open this project',
    body: 'A setting it needs is missing. Slicing here still works.'
  },
  filamentPhysics: {
    title: 'This project is missing its material settings',
    body: 'Its materials are named, but not their temperatures and flow, so Bambu Studio opens them with default settings.'
  },
  filamentIds: {
    title: 'This project’s materials don’t match their presets',
    body: 'Bambu Studio opens them with default settings instead of the materials you chose. Slicing here still works.'
  },
  // The only one that kills the slice before it starts, so the copy says "every slice" rather than
  // "can fail": the user has watched it fail repeatedly by the time they read this, and softer
  // wording reads as guesswork.
  inheritsGroup: {
    title: 'This project still lists materials it no longer has',
    body: 'Every slice of this file fails until it’s repaired.'
  },
  // Like inheritsGroup, the consequence is certain rather than possible, so state it outright.
  objectExtruder: {
    title: 'Some objects aren’t linked to their material',
    body: 'They print in material 1 instead of the one you chose.'
  }
}

/** Several at once: name the worst consequence first, without hiding the others. */
const REPAIR_COPY_BOTH = {
  title: 'This project’s settings need repairing',
  body: 'Several settings disagree with each other, which can make slicing fail or show the wrong materials.'
}

export function RepairProjectSettingsAlert({ reasons, archivedVersion, onRepairInEditor, repairingInEditor, repairInEditorError, sx }: {
  /**
   * Which invariants the project breaks (`settingsRepairReasons` on the library DTO / 3MF index).
   * Empty or omitted falls back to the flush-matrix wording: the only cause that existed before
   * this was surfaced, so an older cached DTO still reads sensibly.
   */
  reasons?: readonly ThreeMfSettingsRepairReason[]
  /**
   * The project on screen is an ARCHIVED version, not the file's head. Repairing it means
   * restoring it first, a decision the user should make knowingly, so no Repair button is
   * offered and the advisory names that remedy.
   */
  archivedVersion?: boolean
  /**
   * Stages the in-editor repairs as an EDIT, the byte-level settings repairs, which the bake
   * applies at save time, and the physics restore, and marks the project dirty rather than
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
   * Why the in-editor repair could not fully run: shown in place of the body. The physics half is
   * all-or-nothing, so a slot whose preset does not resolve means those values were not restored,
   * and saying so is the difference between "it did nothing" and "it silently half-worked".
   */
  repairInEditorError?: string | null
  sx?: SxProps
}): JSX.Element {
  const copy = reasons && reasons.length > 1
    ? REPAIR_COPY_BOTH
    : REPAIR_COPY[reasons?.[0] ?? 'flushMatrix']

  // THE repair model: stage as an undoable edit, persist on save: identical for every defect and
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
          {/* The remedy is FIVE words, and it used to be two sentences of process detail appended to
              every message ("stages the fix as an edit", "anything that can't be repaired with
              certainty is flagged again"). Both were true and neither was the reader's problem: the
              staging detail describes our implementation, and the certainty caveat warned about a
              partial repair that now reports itself directly (`repairInEditorError`). Long notices
              get skipped, which is the one outcome this alert cannot afford. */}
          <Typography level="body-sm">
            {repairInEditorError ?? `${copy.body} Repair, then save the project.`}
          </Typography>
        </div>
      </Alert>
    )
  }

  // Advisory: no editor session to stage into. The remedy always points at where repairing
  // actually happens, the editor, rather than offering an action this surface cannot honour.
  const remedy = archivedVersion
    ? 'This is an older version. Restore it first if you want to repair and use it.'
    : reasons?.length && reasons.every((reason) => reason === 'filamentPhysics')
      ? 'Open it in the editor and save to restore them.'
      : 'Open it in the editor and press Repair, then save.'
  return (
    <Alert variant="soft" color="warning" startDecorator={<WarningAmberIcon />} sx={[{ alignItems: 'flex-start' }, ...(Array.isArray(sx) ? sx : [sx])]}>
      <div>
        <Typography level="title-sm">{copy.title}</Typography>
        <Typography level="body-sm">{`${copy.body} ${remedy}`}</Typography>
      </div>
    </Alert>
  )
}
