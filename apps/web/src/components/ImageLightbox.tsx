/**
 * Full-size image viewer dialog ("lightbox"): a centered modal with zoom
 * controls and an optional download action. Shared by every
 * surface that expands an inline thumbnail (job history media, support
 * message attachments) so image viewing behaves the same everywhere.
 * Render it conditionally: mounting it means open.
 *
 * One of the few dialogs that dismisses on a click outside it. The app-wide rule is that
 * only a deliberate gesture closes a dialog (see `BackAwareModal`), because a misjudged
 * click at a dialog's edge should not discard someone's half-filled form. A lightbox holds
 * no such work, and the dark surround genuinely reads as "the thing I am looking past".
 */
import { useState } from 'react'
import { Box, Button, DialogActions, ModalClose, ModalDialog, Typography } from '@mui/joy'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import ZoomInRoundedIcon from '@mui/icons-material/ZoomInRounded'
import ZoomOutRoundedIcon from '@mui/icons-material/ZoomOutRounded'
import { BackAwareModal as Modal } from './BackAwareModal'

const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const

export function ImageLightbox({
  src,
  alt,
  title,
  downloadName,
  onClose
}: {
  src: string
  alt: string
  /** Optional heading (e.g. a filename or tile label). */
  title?: string
  /** A caller-provided filename enables downloading the image. */
  downloadName?: string
  onClose: () => void
}) {
  const [zoomIndex, setZoomIndex] = useState(0)
  const zoom = ZOOM_LEVELS[zoomIndex]!

  return (
    <Modal open onClose={onClose} dismissOnBackdropClick>
      <ModalDialog sx={{ p: 1.5, width: { xs: '95vw', sm: '90vw', md: '70vw' }, maxWidth: 720 }}>
        <ModalClose />
        {title && <Typography level="title-md" sx={{ mb: 1, pr: 4 }} noWrap>{title}</Typography>}
        <Box
          sx={{
            maxHeight: '75vh',
            overflow: 'auto',
            borderRadius: 'sm',
            backgroundColor: 'var(--joy-palette-neutral-800)'
          }}
        >
          <Box
            component="img"
            src={src}
            alt={alt}
            sx={{
              width: `${zoom * 100}%`,
              maxHeight: zoomIndex === 0 ? '75vh' : 'none',
              height: 'auto',
              objectFit: 'contain',
              display: 'block'
            }}
          />
        </Box>
        <DialogActions sx={{ flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            startDecorator={<ZoomOutRoundedIcon />}
            disabled={zoomIndex === 0}
            onClick={() => setZoomIndex((current) => current - 1)}
          >
            Zoom out
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            startDecorator={<ZoomInRoundedIcon />}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            onClick={() => setZoomIndex((current) => current + 1)}
          >
            Zoom in
          </Button>
          {downloadName && (
            <Button
              component="a"
              href={src}
              download={downloadName}
              size="sm"
              variant="plain"
              color="neutral"
              startDecorator={<DownloadRoundedIcon />}
            >
              Download
            </Button>
          )}
          <Button size="sm" variant="plain" color="neutral" onClick={onClose}>Close</Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}
