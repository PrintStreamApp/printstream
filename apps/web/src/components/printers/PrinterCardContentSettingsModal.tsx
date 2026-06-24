import { useState } from 'react'
import { Button, ModalClose, Stack, Typography } from '@mui/joy'
import type { PrinterCardContentSettings } from '@printstream/shared'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { PrinterCardContentSettingsFields } from './PrinterCardContentSettingsFields'

/**
 * The single-printer view editor: a focused "Edit view" dialog exposing only
 * the per-card content toggles. Unlike PrinterViewsModal it has no name,
 * layout, filter, or printer-selection controls — the single-printer view
 * always shows one card, and these settings apply to it for every printer.
 */
export function PrinterCardContentSettingsModal({
  initialSettings,
  defaultSettings,
  onClose,
  onSave
}: {
  initialSettings: PrinterCardContentSettings
  /** Values applied by the "Reset to defaults" action. */
  defaultSettings: PrinterCardContentSettings
  onClose: () => void
  onSave: (settings: PrinterCardContentSettings) => void
}) {
  const [draft, setDraft] = useState<PrinterCardContentSettings>(() => ({ ...initialSettings }))

  const handleSubmit = (event: React.FormEvent<HTMLDivElement>) => {
    event.preventDefault()
    onSave(draft)
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog
        component="form"
        onSubmit={handleSubmit}
        sx={{ width: { xs: '96vw', sm: 520 }, maxWidth: '100%' }}
      >
        <ModalClose />
        <Typography level="h4">Edit view</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Choose which status blocks appear on the printer card. These settings apply to the single-printer view for every printer.
        </Typography>

        <ScrollableDialogBody sx={{ mt: 1.5 }}>
          <PrinterCardContentSettingsFields
            value={draft}
            onChange={(key, checked) => setDraft((current) => ({ ...current, [key]: checked }))}
          />
        </ScrollableDialogBody>

        <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" sx={{ mt: 2 }}>
          <Button
            type="button"
            variant="plain"
            color="neutral"
            onClick={() => setDraft({ ...defaultSettings })}
          >
            Reset to defaults
          </Button>
          <Stack direction="row" spacing={1} alignItems="center">
            <Button type="button" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </Stack>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
