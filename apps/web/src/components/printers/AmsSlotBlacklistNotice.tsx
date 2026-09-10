/**
 * "Bambu does not recommend this material here" notice inside the AMS slot editor
 * (`AmsSlotEditModal`), shown against the filament the user is about to assign.
 *
 * BambuStudio's second blacklist call site (`AMSMaterialsSetting::on_select_ok`), and the earliest
 * point anyone can be told that TPU does not belong in an AMS. The rules and the wording are the
 * shared `checkFilamentBlacklistForAssignment`'s, the same ones the print dialogs and the dispatch
 * guard use.
 *
 * DIVERGENCE, deliberate: BambuStudio refuses to apply the assignment on a prohibition (an OK-only
 * error dialog, and the setting is dropped). We warn and still let the slot be labelled, because
 * this dialog records what is PHYSICALLY IN the slot. The spool is already loaded by the time
 * anyone opens this; refusing the label would leave the app describing a machine that does not
 * exist, and would not remove one gram of TPU from the AMS. The guard that matters, refusing to
 * PRINT with it, runs at dispatch, where there is still something to prevent.
 *
 * Renders nothing when no rule matched, so the caller can mount it unconditionally.
 */
import { Alert, Link, Stack, Typography } from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { blacklistProhibitions, type FilamentBlacklistFinding } from '@printstream/shared'

export function AmsSlotBlacklistNotice({ findings }: { findings: FilamentBlacklistFinding[] }) {
  if (findings.length === 0) return null
  // One alert, coloured by the worst finding: this is a notice about one slot's one material, and
  // splitting it in two the way the print dialogs do would be two alerts saying the same thing.
  const hasProhibition = blacklistProhibitions(findings).length > 0

  return (
    <Alert
      color={hasProhibition ? 'danger' : 'warning'}
      variant="soft"
      startDecorator={<WarningAmberRoundedIcon />}
    >
      <Stack spacing={0.5} sx={{ width: '100%' }}>
        <Typography level="title-sm">
          {hasProhibition ? 'Bambu does not support this material here' : 'Handle this material with care'}
        </Typography>
        {findings.map((finding) => (
          <Typography key={finding.message} level="body-xs">
            {finding.message}
            {finding.wikiUrl ? (
              <>
                {' '}
                <Link href={finding.wikiUrl} target="_blank" rel="noreferrer">Learn more</Link>
              </>
            ) : null}
          </Typography>
        ))}
        {hasProhibition ? (
          <Typography level="body-xs" textColor="text.tertiary">
            You can still record it here so the slot matches what is loaded. Printing with it needs a
            separate confirmation.
          </Typography>
        ) : null}
      </Stack>
    </Alert>
  )
}
