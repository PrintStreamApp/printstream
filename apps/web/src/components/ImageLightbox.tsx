/**
 * Full-size image viewer dialog ("lightbox"): a centered modal with a close
 * button and the image letterboxed to fit the viewport. Shared by every
 * surface that expands an inline thumbnail (job history media, support
 * message attachments) so image viewing behaves the same everywhere.
 * Render it conditionally — mounting it means open.
 */
import { Box, ModalClose, ModalDialog, Typography } from '@mui/joy'
import { BackAwareModal as Modal } from './BackAwareModal'

export function ImageLightbox({
  src,
  alt,
  title,
  onClose
}: {
  src: string
  alt: string
  /** Optional heading (e.g. a filename or tile label). */
  title?: string
  onClose: () => void
}) {
  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ p: 1.5, width: { xs: '95vw', sm: '90vw', md: '70vw' }, maxWidth: 720 }}>
        <ModalClose />
        {title && <Typography level="title-md" sx={{ mb: 1, pr: 4 }} noWrap>{title}</Typography>}
        <Box
          component="img"
          src={src}
          alt={alt}
          sx={{
            width: '100%',
            maxHeight: '75vh',
            height: 'auto',
            objectFit: 'contain',
            display: 'block',
            borderRadius: 'sm',
            backgroundColor: 'var(--joy-palette-neutral-800)'
          }}
        />
      </ModalDialog>
    </Modal>
  )
}
