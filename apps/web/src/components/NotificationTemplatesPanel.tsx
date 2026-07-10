/**
 * Editable notification templates panel, shared by both notification scopes.
 *
 * Each template trigger is shown as a compact row with the current
 * title/body. Editing happens in a focused Modal dialog so the page
 * stays scannable when many triggers exist. The server is the source
 * of truth (and owns the defaults), so this component is mostly a
 * controlled-form wrapper around `/api/notifications/templates` (tenant
 * print events) or `/api/notifications/platform-templates` (platform
 * operator events — a dynamic, deployment-registered set with no snapshot
 * media; the panel renders nothing when the deployment registers none).
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
import { apiFetch } from '../lib/apiClient'
import { BackAwareModal as Modal } from './BackAwareModal'
import { ConfirmActionDialog } from './ConfirmActionDialog'
import { DialogSection } from './DialogSection'

/**
 * Structural template shape covering both scopes: the tenant print-event
 * templates carry `includeSnapshot`; platform templates do not.
 */
export interface EditableNotificationTemplate {
  event: string
  label: string
  enabled: boolean
  title: string
  body: string
  variables: string[]
  customized: boolean
  defaults: { title: string; body: string }
  includeSnapshot?: boolean
}

interface TemplateListResponse {
  templates: EditableNotificationTemplate[]
}

interface TemplateResponse {
  template: EditableNotificationTemplate
}

export type NotificationTemplateScope = 'tenant' | 'platform'

function templatesEndpoint(scope: NotificationTemplateScope): string {
  return scope === 'platform' ? '/api/notifications/platform-templates' : '/api/notifications/templates'
}

export function NotificationTemplatesPanel({ scope = 'tenant' }: { scope?: NotificationTemplateScope } = {}) {
  const query = useQuery({
    queryKey: ['notification-templates', scope],
    queryFn: ({ signal }) => apiFetch<TemplateListResponse>(templatesEndpoint(scope), { signal })
  })
  const [editing, setEditing] = useState<EditableNotificationTemplate | null>(null)

  // The platform event set is deployment-registered and may be empty (OSS
  // registers none today); hide the whole section rather than an empty card.
  if (scope === 'platform' && !query.isLoading && !query.error && (query.data?.templates.length ?? 0) === 0) {
    return null
  }

  return (
    <Stack spacing={1.5}>
      <Typography level="body-sm" textColor="text.tertiary">
        {scope === 'platform'
          ? 'Customise the title and body sent for each platform event. Templates are shared by every notification channel configured for the platform workspace. Use '
          : 'Customise the title, body, and media sent for each notification event. Templates are shared by every notification channel (ntfy, Discord, browser push). Use '}
        <code>{'{{variable}}'}</code> placeholders to insert event details.
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
        scope={scope}
        template={editing}
        onClose={() => setEditing(null)}
      />
    </Stack>
  )
}

interface TemplateRowProps {
  template: EditableNotificationTemplate
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
  scope: NotificationTemplateScope
  template: EditableNotificationTemplate | null
  onClose: () => void
}

function TemplateEditorDialog({ scope, template, onClose }: TemplateEditorDialogProps) {
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
    setIncludeSnapshot(template.includeSnapshot ?? false)
    setError(null)
  }, [template])

  const dirty = useMemo(() => {
    if (!template) return false
    return (
      enabled !== template.enabled ||
      title !== template.title ||
      body !== template.body ||
      includeSnapshot !== (template.includeSnapshot ?? false)
    )
  }, [template, enabled, title, body, includeSnapshot])

  const save = useMutation({
    mutationFn: (update: { enabled: boolean; title: string; body: string; includeSnapshot?: boolean }) => {
      if (!template) throw new Error('No template selected')
      return apiFetch<TemplateResponse>(
        `${templatesEndpoint(scope)}/${encodeURIComponent(template.event)}`,
        { method: 'PUT', body: update }
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notification-templates', scope] })
      onClose()
    },
    onError: (caught: Error) => setError(caught.message)
  })

  const reset = useMutation({
    mutationFn: () => {
      if (!template) throw new Error('No template selected')
      return apiFetch<TemplateResponse>(
        `${templatesEndpoint(scope)}/${encodeURIComponent(template.event)}`,
        { method: 'DELETE' }
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notification-templates', scope] })
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

                {scope === 'tenant' && (
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
                )}

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
              onClick={() => save.mutate({ enabled, title, body, ...(scope === 'tenant' ? { includeSnapshot } : {}) })}
            >
              Save
            </Button>
          </DialogActions>
        </ModalDialog>

        <ConfirmActionDialog
          open={confirmResetOpen}
          title="Reset notification template?"
          description={template
            ? scope === 'tenant'
              ? `Reset "${template.label}" to its default title, body, enabled state, and snapshot setting? Your custom version will be removed.`
              : `Reset "${template.label}" to its default title, body, and enabled state? Your custom version will be removed.`
            : ''}
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
