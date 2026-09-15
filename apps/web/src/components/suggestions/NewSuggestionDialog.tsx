/**
 * "New suggestion" dialog: title + optional details, posted to the shared
 * platform-wide board. Self-contained: performs its own `apiFetch` POST and
 * reports the created post via `onCreated`.
 */
import { useState } from 'react'
import { Box, Button, FormControl, FormHelperText, FormLabel, Input, ModalDialog, Stack, Textarea, Typography } from '@mui/joy'
import type { SuggestionResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { BackAwareModal as Modal } from '../BackAwareModal'

export function NewSuggestionDialog({
  apiBase = '/api/plugins/suggestions',
  onClose,
  onCreated
}: {
  apiBase?: string
  onClose: () => void
  onCreated: (suggestionId: string) => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const canSubmit = title.trim().length > 0

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const response = await apiFetch<SuggestionResponse>(apiBase, {
        method: 'POST',
        body: { title: title.trim(), body: body.trim() }
      })
      onCreated(response.suggestion.id)
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || submitting) return
    void submit()
  }

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 520, width: '100%' }}>
        <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography level="h4">New suggestion</Typography>
          <FormControl>
            <FormLabel>Title</FormLabel>
            <Input
              value={title}
              autoFocus
              placeholder="One line that sums up the idea"
              onChange={(event) => setTitle(event.target.value)}
            />
          </FormControl>
          <FormControl>
            <FormLabel>Details (optional)</FormLabel>
            <Textarea
              value={body}
              minRows={3}
              maxRows={10}
              placeholder="What problem would it solve? How do you imagine it working?"
              onChange={(event) => setBody(event.target.value)}
            />
            <FormHelperText>Markdown is supported.</FormHelperText>
          </FormControl>
          {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 0.5 }}>
            <Button type="button" variant="plain" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={submitting} disabled={!canSubmit}>Post suggestion</Button>
          </Stack>
        </Box>
      </ModalDialog>
    </Modal>
  )
}
