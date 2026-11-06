/**
 * Displays the active plate's problems inside the viewport: placement problems from the geometry
 * validator, plus anything else the editor knows will print wrong (linked copies printed by object).
 * The editor owns warning computation and dismissal; this component only names the first few
 * issues, routes a click to the affected object, and offers a row's fix when it has one.
 */
import { IconButton, Link, Sheet, Stack, Typography } from '@mui/joy'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
/**
 * One object's row. A `PlacementWarning` is one as it stands; other sources add a `fix` when the
 * editor can repair the problem in one step.
 */
export interface EditorViewportIssue {
  /** Unique per row. A placement warning's is its instance key. */
  key: string
  /** The instance a click selects, when it is not `key` (a second row about the same object). */
  selectKey?: string
  name: string
  issues: string[]
  fix?: { label: string; onApply: () => void }
}

interface EditorPlacementWarningsProps {
  warnings: ReadonlyArray<EditorViewportIssue>
  onDismiss: () => void
  onSelect: (key: string) => void
}

/** Render a dismissible warning summary anchored to the viewport's lower corner. */
export function EditorPlacementWarnings({ warnings, onDismiss, onSelect }: EditorPlacementWarningsProps) {
  return (
    <Sheet
      variant="soft"
      color="danger"
      sx={{
        position: 'absolute', right: 8, bottom: { xs: 50, sm: 8 }, zIndex: 2,
        maxWidth: 'min(300px, calc(100% - 16px))', p: 1, borderRadius: 'sm',
        boxShadow: 'sm', display: 'flex', flexDirection: 'column', gap: 0.25
      }}
    >
      <Stack direction="row" spacing={0.5} alignItems="center">
        <WarningRoundedIcon fontSize="small" />
        <Typography level="body-xs" fontWeight="lg" sx={{ color: 'inherit', flex: 1 }}>
          {warnings.length} {warnings.length === 1 ? 'issue' : 'issues'}
        </Typography>
        <IconButton
          size="sm"
          variant="plain"
          color="danger"
          onClick={onDismiss}
          aria-label="Dismiss plate issues"
          sx={{ '--IconButton-size': '20px', minWidth: 20, minHeight: 20 }}
        >
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Stack>
      {warnings.slice(0, 3).map((warning) => (
        <Stack key={warning.key} direction="row" spacing={0.75} alignItems="baseline" flexWrap="wrap">
          <Link
            component="button"
            type="button"
            level="body-xs"
            textColor="inherit"
            sx={{ display: 'block', textAlign: 'left' }}
            onClick={() => onSelect(warning.selectKey ?? warning.key)}
          >
            {warning.name}: {warning.issues.join(', ')}
          </Link>
          {warning.fix && (
            <Link
              component="button"
              type="button"
              level="body-xs"
              textColor="inherit"
              fontWeight="lg"
              underline="always"
              onClick={warning.fix.onApply}
            >
              {warning.fix.label}
            </Link>
          )}
        </Stack>
      ))}
      {warnings.length > 3 && (
        <Typography level="body-xs" sx={{ color: 'inherit', opacity: 0.8 }}>
          +{warnings.length - 3} more
        </Typography>
      )}
    </Sheet>
  )
}
