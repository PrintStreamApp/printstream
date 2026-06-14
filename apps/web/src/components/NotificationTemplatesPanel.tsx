/**
 * Editable notification templates panel.
 *
 * Each template trigger is shown as a compact row with the current
 * title/body. Editing happens in a focused Modal dialog so the page
 * stays scannable when many triggers exist. The server is the source
 * of truth (and owns the defaults), so this component is mostly a
 * controlled-form wrapper around `/api/notifications/templates`.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Input,
  ModalDialog,
  Stack,
  Switch,
  Textarea,
  Typography
} from '@mui/joy'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { NotificationTemplate, NotificationTemplateUpdate } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { BackAwareModal as Modal } from './BackAwareModal'
import { ConfirmActionDialog } from './ConfirmActionDialog'
import { DialogSection } from './DialogSection'

interface TemplateListResponse {
  templates: NotificationTemplate[]
}

interface TemplateResponse {
  template: NotificationTemplate
}

export function NotificationTemplatesPanel() {
  const query = useQuery({
    queryKey: ['notification-templates'],
    queryFn: () => apiFetch<TemplateListResponse>('/api/notifications/templates')
  })
  const [editing, setEditing] = useState<NotificationTemplate | null>(null)

  return (
    <Stack spacing={1.5}>
      <Typography level="body-sm" textColor="text.tertiary">
        Customise the title, body, and media sent for each notification event.
        Templates are shared by every notification channel (ntfy, Discord,
        browser push). Use <code>{'{{variable}}'}</code> placeholders to insert
        printer or job details.
      </Typography>
      {query.isLoading && <Typography level="body-sm">Loading…</Typography>}
      {query.error && (
        <Typography level="body-sm" color="danger">
          {(query.error as Error).message}
        </Typography>
      )}
      <Card variant="outlined">
        <CardContent>
          <Stack divider={<Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }} />}>
            {query.data?.templates.map((template) => (
              <TemplateRow
                key={template.event}
                template={template}
                onEdit={() => setEditing(template)}
              />
            ))}
          </Stack>
        </CardContent>
      </Card>

      <TemplateEditorDialog
        template={editing}
        onClose={() => setEditing(null)}
      />
    </Stack>
  )
}

interface TemplateRowProps {
  template: NotificationTemplate
  onEdit: () => void
}

function TemplateRow({ template, onEdit }: TemplateRowProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        columnGap: 1,
        rowGap: 0.75,
        alignItems: 'start',
        py: 1
      }}
    >
      <Stack spacing={0.25} sx={{ minWidth: 0, width: '100%' }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography level="title-sm">{template.label}</Typography>
          {template.customized && (
            <Chip size="sm" variant="soft" color="primary">customised</Chip>
          )}
          {!template.enabled && (
            <Chip size="sm" variant="soft" color="neutral">muted</Chip>
          )}
          {template.includeSnapshot && (
            <Chip size="sm" variant="soft" color="success">snapshot</Chip>
          )}
        </Stack>
        <Typography level="body-xs" textColor="text.tertiary" noWrap>
          {template.title}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary" noWrap>
          {template.body}
        </Typography>
      </Stack>
      <Button size="sm" variant="outlined" onClick={onEdit} sx={{ alignSelf: 'start' }}>
        Edit
      </Button>
    </Box>
  )
}

interface TemplateEditorDialogProps {
  template: NotificationTemplate | null
  onClose: () => void
}

function TemplateEditorDialog({ template, onClose }: TemplateEditorDialogProps) {
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [includeSnapshot, setIncludeSnapshot] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmResetOpen, setConfirmResetOpen] = useState(false)

  // Reset local state whenever the dialog opens for a new template.
  useEffect(() => {
    if (!template) return
    setEnabled(template.enabled)
    setTitle(template.title)
    setBody(template.body)
    setIncludeSnapshot(template.includeSnapshot)
    setError(null)
  }, [template])

  const dirty = useMemo(() => {
    if (!template) return false
    return (
      enabled !== template.enabled ||
      title !== template.title ||
      body !== template.body ||
      includeSnapshot !== template.includeSnapshot
    )
  }, [template, enabled, title, body, includeSnapshot])

  const save = useMutation({
    mutationFn: (update: NotificationTemplateUpdate) => {
      if (!template) throw new Error('No template selected')
      return apiFetch<TemplateResponse>(
        `/api/notifications/templates/${encodeURIComponent(template.event)}`,
        { method: 'PUT', body: update }
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notification-templates'] })
      onClose()
    },
    onError: (caught: Error) => setError(caught.message)
  })

  const reset = useMutation({
    mutationFn: () => {
      if (!template) throw new Error('No template selected')
      return apiFetch<TemplateResponse>(
        `/api/notifications/templates/${encodeURIComponent(template.event)}`,
        { method: 'DELETE' }
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notification-templates'] })
      onClose()
    },
    onError: (caught: Error) => setError(caught.message)
  })

  const busy = save.isPending || reset.isPending

  return (
    <Modal open={template != null} onClose={() => { if (!busy) onClose() }}>
      <>
        <ModalDialog
          variant="outlined"
          sx={{ width: { xs: '95vw', sm: 520 }, maxWidth: '95vw' }}
        >
          <DialogTitle>{template?.label ?? 'Edit notification'}</DialogTitle>
          <DialogContent>
            {template && (
              <Stack spacing={2}>
                <DialogSection
                  title="Delivery"
                  description="Choose whether this event should send a notification when it fires."
                >
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Typography level="body-sm">Send this notification</Typography>
                    <Switch
                      checked={enabled}
                      disabled={busy}
                      onChange={(event) => setEnabled(event.target.checked)}
                    />
                  </Stack>
                </DialogSection>

                <DialogSection
                  title="Message"
                  description="Customize the title and body shared across every enabled notification channel."
                >
                  <Stack spacing={1.25}>
                    <FormControl>
                      <FormLabel>Title</FormLabel>
                      <Input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder={template.defaults.title}
                        disabled={busy || !enabled}
                      />
                    </FormControl>

                    <FormControl>
                      <FormLabel>Body</FormLabel>
                      <Textarea
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                        placeholder={template.defaults.body}
                        minRows={3}
                        disabled={busy || !enabled}
                      />
                    </FormControl>
                  </Stack>
                </DialogSection>

                <DialogSection
                  title="Media"
                  description="Attach a chamber-camera frame when the selected printer supports it and the channel can display media."
                >
                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <Typography level="body-sm">Attach camera snapshot</Typography>
                    <Switch
                      checked={includeSnapshot}
                      disabled={busy || !enabled}
                      onChange={(event) => setIncludeSnapshot(event.target.checked)}
                    />
                  </Stack>
                </DialogSection>

                <DialogSection
                  title="Variables"
                  description="Use these placeholders in the title and body."
                >
                  <Typography level="body-sm">
                    {template.variables.map((name) => `{{${name}}}`).join(', ')}
                  </Typography>
                </DialogSection>

                {error && (
                  <Typography level="body-sm" color="danger">{error}</Typography>
                )}
              </Stack>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              disabled={busy || !template?.customized}
              loading={reset.isPending}
              onClick={() => setConfirmResetOpen(true)}
            >
              Reset to default
            </Button>
            <Box sx={{ flex: 1 }} />
            <Button
              variant="plain"
              color="neutral"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              disabled={busy || !dirty}
              loading={save.isPending}
              onClick={() => save.mutate({ enabled, title, body, includeSnapshot })}
            >
              Save
            </Button>
          </DialogActions>
        </ModalDialog>

        <ConfirmActionDialog
          open={confirmResetOpen}
          title="Reset notification template?"
          description={template ? `Reset "${template.label}" to its default title, body, enabled state, and snapshot setting? Your custom version will be removed.` : ''}
          confirmLabel="Reset to default"
          pending={reset.isPending}
          error={error}
          onClose={() => setConfirmResetOpen(false)}
          onConfirm={() => {
            setConfirmResetOpen(false)
            reset.mutate()
          }}
        />
      </>
    </Modal>
  )
}
