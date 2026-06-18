/**
 * Per-object process overrides dialog.
 *
 * Lists the objects on the selected plate and lets the user open a restricted
 * {@link ProcessSettingsDialog} for any one of them. Each object's overrides are diffed against
 * the global effective config (the profile plus global overrides), so per-object edits read and
 * reset relative to what the object would otherwise inherit — matching Bambu Studio.
 */
import { useMemo, useState } from 'react'
import { Button, Chip, DialogActions, Divider, List, ListItem, ListItemContent, Stack, Switch, Tooltip, Typography } from '@mui/joy'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import { PER_OBJECT_PROCESS_KEYS, type ProcessSettingOverrides, type ProcessVisibilityContext } from '@printstream/shared'
import { BackAwareModal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import ProcessSettingsDialog from './ProcessSettingsDialog'

export interface PerObjectSettingsDialogProps {
  open: boolean
  onClose: () => void
  objects: Array<{ id: number; name: string }>
  slicerTargetId: string
  processProfileId: string
  processProfileName: string
  sourceFileId?: string | null
  /** Global process overrides; the per-object baseline = profile + these. */
  globalOverrides: ProcessSettingOverrides
  visibilityContext?: Partial<ProcessVisibilityContext>
  /** Per-object overrides keyed by object id (string). */
  value: Record<string, ProcessSettingOverrides>
  onChange: (next: Record<string, ProcessSettingOverrides>) => void
  /** Object ids that will be printed; toggling controls which objects the slice includes. */
  printSelection: Set<number>
  onTogglePrint: (objectId: number) => void
  /** Apply-button wording for the inner per-object dialog (project editor vs one-off slice). */
  applyScope?: 'project' | 'slice'
}

/** Stable empty-overrides reference so the editor's resolve effect doesn't re-fetch every render. */
const EMPTY_OVERRIDES: ProcessSettingOverrides = {}

export default function PerObjectSettingsDialog(props: PerObjectSettingsDialogProps): JSX.Element {
  const { open, onClose, objects, slicerTargetId, processProfileId, processProfileName, sourceFileId, globalOverrides, visibilityContext, value, onChange, printSelection, onTogglePrint, applyScope } = props
  const [editingObjectId, setEditingObjectId] = useState<number | null>(null)
  const editingObject = objects.find((object) => object.id === editingObjectId) ?? null
  // Stabilize the per-object overrides reference; `value[id] ?? {}` would otherwise be a fresh
  // object each render and retrigger the editor's resolve effect, leaving it stuck loading.
  const editingObjectOverrides = useMemo(
    () => (editingObjectId != null ? value[String(editingObjectId)] ?? EMPTY_OVERRIDES : EMPTY_OVERRIDES),
    [editingObjectId, value]
  )
  // Memoize the per-object visibility context for the same reason (it feeds field-state memos).
  const objectVisibilityContext = useMemo(
    () => ({ ...visibilityContext, isGlobalConfig: false }),
    [visibilityContext]
  )

  const applyObjectOverrides = (objectId: number, overrides: ProcessSettingOverrides) => {
    const next = { ...value }
    if (Object.keys(overrides).length === 0) delete next[String(objectId)]
    else next[String(objectId)] = overrides
    onChange(next)
    setEditingObjectId(null)
  }

  return (
    <>
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 520, width: '100%' }}>
        <Typography level="h4">Per-object settings — {processProfileName}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.5 }}>
          Toggle which objects to print, and override process settings per object. Each object
          otherwise inherits the global settings.
        </Typography>
        <ScrollableDialogBody sx={{ mt: 1, px: 0 }}>
          <List sx={{ '--ListItem-paddingX': '0.5rem' }}>
            {objects.map((object) => {
              const customCount = Object.keys(value[String(object.id)] ?? {}).length
              const printing = printSelection.has(object.id)
              return (
                <ListItem key={object.id}>
                  <ListItemContent>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                      <Tooltip title={printing ? 'Printing — toggle to skip' : 'Skipped — toggle to print'} variant="soft">
                        <Switch
                          size="sm"
                          checked={printing}
                          onChange={() => onTogglePrint(object.id)}
                          slotProps={{ input: { 'aria-label': `Print ${object.name}` } }}
                          sx={{ flexShrink: 0 }}
                        />
                      </Tooltip>
                      <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0, opacity: printing ? 1 : 0.5 }}>{object.name}</Typography>
                      {customCount > 0 && (
                        <Chip size="sm" variant="soft" color="warning" sx={{ flexShrink: 0 }}>
                          {customCount} custom
                        </Chip>
                      )}
                      <Button
                        size="sm"
                        variant="outlined"
                        color="neutral"
                        startDecorator={<EditRoundedIcon />}
                        onClick={() => setEditingObjectId(object.id)}
                        sx={{ flexShrink: 0 }}
                      >
                        Edit
                      </Button>
                    </Stack>
                  </ListItemContent>
                </ListItem>
              )
            })}
          </List>
        </ScrollableDialogBody>
        <Divider />
        <DialogActions>
          <Button variant="solid" onClick={onClose}>Done</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
    {editingObject && (
      <ProcessSettingsDialog
        open
        onClose={() => setEditingObjectId(null)}
        slicerTargetId={slicerTargetId}
        processProfileId={processProfileId}
        processProfileName={editingObject.name}
        sourceFileId={sourceFileId}
        initialOverrides={editingObjectOverrides}
        visibilityContext={objectVisibilityContext}
        allowedKeys={PER_OBJECT_PROCESS_KEYS}
        baseOverlay={globalOverrides}
        titlePrefix="Object settings"
        applyScope={applyScope}
        onApply={(overrides) => applyObjectOverrides(editingObject.id, overrides)}
      />
    )}
    </>
  )
}
