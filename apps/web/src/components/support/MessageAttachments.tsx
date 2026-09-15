/**
 * Attachment strip under a support message bubble: inline thumbnails for
 * image attachments (click opens a full-size lightbox) and download chips
 * for everything else. `base` is the viewer's support API root
 * (`/api/support` or `/api/platform/support`); its `/attachments/:id` route
 * enforces that viewer's access, so this component never needs to.
 */
import { useState } from 'react'
import { Box, Chip, Link, Stack } from '@mui/joy'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { formatBytes, type SupportAttachment } from '@printstream/shared'
import { buildApiUrl } from '../../lib/apiUrl'
import { ImageLightbox } from '../ImageLightbox'

export function MessageAttachments({
  attachments,
  base,
  align,
  inlineAttachmentIds
}: {
  attachments: ReadonlyArray<SupportAttachment>
  base: string
  align: 'flex-start' | 'flex-end'
  /**
   * Attachments already rendered inline in the message body (pasted images,
   * referenced as `attachment:<id>`): the strip skips their thumbnail and
   * shows just a download chip so the image doesn't appear twice.
   */
  inlineAttachmentIds?: ReadonlySet<string>
}) {
  const [lightbox, setLightbox] = useState<SupportAttachment | null>(null)
  if (attachments.length === 0) return null
  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{ flexWrap: 'wrap', maxWidth: '85%', justifyContent: align }}
    >
      {attachments.map((attachment) => {
        const href = buildApiUrl(`${base}/attachments/${encodeURIComponent(attachment.id)}`)
        return attachment.isImage && !inlineAttachmentIds?.has(attachment.id) ? (
          // Stays a real anchor so middle-/ctrl-click can still open the raw
          // image; a plain click opens the in-app lightbox instead.
          <Link
            key={attachment.id}
            href={href}
            title={attachment.filename}
            onClick={(event) => {
              event.preventDefault()
              setLightbox(attachment)
            }}
          >
            {/* NOT lazy: a message's attachments are a handful of small images that are on
                screen as soon as the conversation opens, and a short thread never scrolls: the
                shape where Chrome leaves a deferred load permanently unstarted inside a dialog
                (see the plate strip in `components/LibraryPlateSelect.tsx`). */}
            <Box
              component="img"
              src={href}
              alt={attachment.filename}
              sx={{
                display: 'block',
                maxWidth: 'min(240px, 100%)',
                maxHeight: 160,
                borderRadius: 'md',
                border: '1px solid',
                borderColor: 'divider'
              }}
            />
          </Link>
        ) : (
          <Chip
            key={attachment.id}
            component="a"
            href={href}
            // Images are served inline; the download attribute keeps the chip a
            // download action instead of navigating to the raw image.
            slotProps={{ root: { download: attachment.filename } }}
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<DownloadRoundedIcon fontSize="small" />}
            sx={{ maxWidth: 260, '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}
          >
            {attachment.filename} ({formatBytes(attachment.sizeBytes)})
          </Chip>
        )
      })}
      {lightbox && (
        <ImageLightbox
          src={buildApiUrl(`${base}/attachments/${encodeURIComponent(lightbox.id)}`)}
          alt={lightbox.filename}
          title={lightbox.filename}
          onClose={() => setLightbox(null)}
        />
      )}
    </Stack>
  )
}
