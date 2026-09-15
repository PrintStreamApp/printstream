/**
 * Shared in-viewport loading treatment for Model Studio and read-only 3D previews.
 *
 * The thin edge progress line and centred status scrim never participate in layout, so building
 * scene content cannot resize the WebGL canvas or be mistaken for one of the scrubber containers.
 */
import { Box, Typography } from '@mui/joy'
import { ProgressBar } from '../../components/ProgressBar'

export interface ViewportBuildOverlayProps {
  progress?: { done: number; total: number } | null
  /** A first/incremental build keeps more of the arriving scene visible than an atomic rebuild. */
  incremental?: boolean
}

/** Render the shared Model Studio viewport build status without affecting viewport geometry. */
export function ViewportBuildOverlay({
  progress = null,
  incremental = true
}: ViewportBuildOverlayProps) {
  const percent = progress && progress.total > 1
    ? Math.round((progress.done / progress.total) * 100)
    : null

  return (
    <>
      <ProgressBar
        value={percent}
        thickness={4}
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 3,
          pointerEvents: 'none',
          '--LinearProgress-radius': '0px'
        }}
      />
      <Box
        role="status"
        aria-live="polite"
        sx={{
          position: 'absolute',
          inset: 0,
          zIndex: 2,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: incremental ? 'rgba(13, 19, 34, 0.4)' : 'rgba(13, 19, 34, 0.55)'
        }}
      >
        <Typography level="body-sm" textColor="common.white">
          {progress && progress.total > 1
            ? `Building the 3D view… ${progress.done} of ${progress.total}`
            : 'Building the 3D view…'}
        </Typography>
      </Box>
    </>
  )
}
