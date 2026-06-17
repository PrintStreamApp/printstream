/**
 * Monospace code/command block with a copy-to-clipboard button. Wraps long
 * lines and preserves newlines so multi-line snippets (e.g. a compose file or a
 * shell command) render verbatim. Shared by the bridge install surfaces.
 */
import { Box, IconButton, Sheet } from '@mui/joy'
import React from 'react'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'

export function CopyableCodeBlock({ text, copyAriaLabel = 'Copy' }: { text: string; copyAriaLabel?: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Sheet variant="soft" sx={{ borderRadius: 'sm', p: 1, display: 'flex', gap: 1, alignItems: 'flex-start' }}>
      <Box
        component="pre"
        sx={{ m: 0, flex: 1, minWidth: 0, fontFamily: 'code', fontSize: 'sm', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      >
        {text}
      </Box>
      <IconButton size="sm" variant="plain" color="neutral" onClick={copy} aria-label={copyAriaLabel}>
        {copied ? <CheckRoundedIcon /> : <ContentCopyRoundedIcon />}
      </IconButton>
    </Sheet>
  )
}
