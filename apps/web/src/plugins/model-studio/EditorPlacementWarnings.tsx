/**
 * Displays the active plate's placement problems inside the viewport.
 * The editor owns warning computation and dismissal; this component only names
 * the first few issues and routes a click to the affected object.
 */
import { IconButton, Link, Sheet, Stack, Typography } from '@mui/joy'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import type { PlacementWarning } from './editorGeometry'

interface EditorPlacementWarningsProps {
  warnings: ReadonlyArray<PlacementWarning>
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
          aria-label="Dismiss placement issues"
          sx={{ '--IconButton-size': '20px', minWidth: 20, minHeight: 20 }}
        >
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Stack>
      {warnings.slice(0, 3).map((warning) => (
        <Link
          key={warning.key}
          component="button"
          type="button"
          level="body-xs"
          textColor="inherit"
          sx={{ display: 'block', textAlign: 'left' }}
          onClick={() => onSelect(warning.key)}
        >
          {warning.name}: {warning.issues.join(', ')}
        </Link>
      ))}
      {warnings.length > 3 && (
        <Typography level="body-xs" sx={{ color: 'inherit', opacity: 0.8 }}>
          +{warnings.length - 3} more
        </Typography>
      )}
    </Sheet>
  )
}
