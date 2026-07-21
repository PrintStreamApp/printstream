import Alert from '@mui/joy/Alert'
import Checkbox from '@mui/joy/Checkbox'
import Typography from '@mui/joy/Typography'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import type { SxProps } from '@mui/joy/styles/types'
import { formatBambuVersion } from '@printstream/shared'

/**
 * Warning + explicit opt-in for a project saved by a NEWER Bambu Studio than the selected slicer
 * engine.
 *
 * Bambu Studio refuses to open such a project outright — the CLI exits before loading anything, so
 * there is no setting or retry that gets past it. It does provide an escape hatch
 * (`--allow-newer-file`), which is what the checkbox enables, mirroring how Bambu Studio itself
 * lets you open a newer project after warning you.
 *
 * The opt-in is deliberate rather than automatic: bypassing the vendor's version gate means an
 * older engine may silently misread settings a newer one wrote, so a slice that SUCCEEDS is not
 * proof the G-code is correct. The copy says that plainly instead of implying the override is free.
 *
 * Counterpart: `allowNewerProjectFile` on the slice request (`packages/shared/src/slicing.ts`),
 * which the slicer turns into the CLI flag.
 */
export function ProjectVersionWarningAlert({ projectVersion, engineVersion, acknowledged, onAcknowledgedChange, sx }: {
  projectVersion: string | null
  engineVersion: string | null
  acknowledged: boolean
  onAcknowledgedChange: (next: boolean) => void
  sx?: SxProps
}): JSX.Element {
  const project = formatBambuVersion(projectVersion) ?? 'a newer version'
  const engine = formatBambuVersion(engineVersion) ?? 'this version'
  return (
    <Alert variant="soft" color="warning" startDecorator={<WarningAmberIcon />} sx={[{ alignItems: 'flex-start' }, ...(Array.isArray(sx) ? sx : [sx])]}>
      <div>
        <Typography level="title-sm">This project is newer than the selected slicer</Typography>
        <Typography level="body-sm">
          It was saved by Bambu Studio {project}, and the selected slicer is {engine}. Bambu Studio
          won’t open a project from a newer version, so this can’t be sliced as-is. Choose a newer
          slicer version if one is listed, re-save the project from Bambu Studio {engine} or older,
          or slice it anyway below.
        </Typography>
        <Checkbox
          size="sm"
          sx={{ mt: 1 }}
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
          label="Slice it anyway — settings added since this project's version may be ignored, so check the result before printing"
        />
      </div>
    </Alert>
  )
}
