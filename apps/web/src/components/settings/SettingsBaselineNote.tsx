/**
 * The "what these change markers are measured against" notice on a settings-catalog dialog.
 *
 * Shown when the dialog could not resolve the preset a project actually used and fell back to
 * something weaker. The RESOLVER reports which fallback it took (`SettingsBaselineOrigin`) and
 * `describeSettingsBaseline` turns that into this text, so the note can never claim a baseline that
 * was not actually consulted: the dialog is not re-deriving anything. Without a note the user sees
 * a "changed" set measured from somewhere other than where they assume, with nothing saying so.
 *
 * One component rather than an Alert per dialog because the condition is identical on each and the
 * dialogs sit side by side in the same sidebar: a process note and a filament note that differ in
 * tone or shade read as two different kinds of problem. The WORDING is shared for the same reason,
 * in `describeSettingsBaseline`.
 */
import { Alert, Typography } from '@mui/joy'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'

export function SettingsBaselineNote({ note }: { note: string }) {
  return (
    <Alert color="neutral" variant="soft" size="sm" startDecorator={<InfoOutlinedIcon fontSize="small" />} sx={{ mt: 1 }}>
      <Typography level="body-xs">{note}</Typography>
    </Alert>
  )
}
