/**
 * Composer control for support-message attachments: an "Attach files" button
 * plus a chip per picked file (upload progress while uploading, delete to
 * remove, danger + tooltip when an upload failed). Purely presentational over
 * `useSupportAttachmentDrafts`, so the help dialog and both conversation
 * composers stay consistent.
 *
 * Progress is determinate because attachments can be large enough to take
 * minutes; an indeterminate spinner would leave the user unable to tell a slow
 * upload from a stuck one.
 */
import { useRef } from 'react'
import { Button, Chip, ChipDelete, CircularProgress, Stack, Tooltip } from '@mui/joy'
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded'
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined'
import { SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE, formatBytes } from '@printstream/shared'
import type { SupportAttachmentDraftsState } from '../hooks/useSupportAttachmentDrafts'

export function SupportAttachmentsField({
  drafts,
  disabled = false
}: {
  drafts: SupportAttachmentDraftsState
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <Stack direction="row" spacing={0.5} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
      {drafts.drafts.map((draft) => {
        const chip = (
          <Chip
            key={draft.key}
            size="sm"
            variant="soft"
            color={draft.status === 'error' ? 'danger' : 'neutral'}
            startDecorator={draft.status === 'uploading'
              ? (
                <CircularProgress
                  size="sm"
                  // Indeterminate until the first chunk lands, so opening the
                  // session does not read as a stalled 0%.
                  determinate={draft.progress > 0}
                  value={Math.round(draft.progress * 100)}
                  sx={{ '--CircularProgress-size': '14px' }}
                />
              )
              : <InsertDriveFileOutlinedIcon fontSize="small" />}
            endDecorator={<ChipDelete disabled={disabled} onDelete={() => drafts.remove(draft.key)} />}
            sx={{ maxWidth: 240, '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}
          >
            {draft.file.name} ({draft.status === 'uploading' && draft.progress > 0
              ? `${Math.round(draft.progress * 100)}%`
              : formatBytes(draft.file.size)})
          </Chip>
        )
        return draft.status === 'error'
          ? <Tooltip key={draft.key} title={draft.error} color="danger" variant="soft" placement="top">{chip}</Tooltip>
          : chip
      })}
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        startDecorator={<AttachFileRoundedIcon fontSize="small" />}
        disabled={disabled || drafts.atCapacity}
        onClick={() => inputRef.current?.click()}
        sx={{ color: 'neutral.500' }}
      >
        Attach files
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) drafts.addFiles(event.target.files)
          // Allow re-picking the same file after removing it.
          event.target.value = ''
        }}
      />
      {drafts.atCapacity && (
        <Chip size="sm" variant="plain" color="neutral" sx={{ color: 'neutral.500' }}>
          Up to {SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE} files per message
        </Chip>
      )}
    </Stack>
  )
}
