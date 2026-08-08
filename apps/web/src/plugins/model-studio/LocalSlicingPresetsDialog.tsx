/**
 * The slicing-preset manager for a host with NO workspace behind it — the public 3MF editor.
 *
 * Counterpart of `components/library/SlicingPresetsDialog.tsx`, which is the workspace manager and
 * talks to `/api/slicing/profiles`. Nothing here touches the api: presets are parsed and stored in
 * the browser by `lib/localSlicingPresets.ts`, the same promise the opened file itself carries.
 *
 * The two managers are deliberately separate components rather than one with a mode flag: the
 * workspace one is a workspace surface (server paging, filters, per-preset editors, delete
 * confirmation across a workspace's shared data), while this one manages a handful of files in one
 * browser. Sharing the shell would mean threading a data seam through every one of those.
 *
 * The PARSE is shared with the workspace path regardless (`@printstream/shared`), so a preset file
 * accepted here is exactly the set accepted by a signed-in upload.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  DialogActions,
  IconButton,
  List,
  ListItem,
  Sheet,
  Stack,
  Typography
} from '@mui/joy'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import { BackAwareModal } from '../../components/BackAwareModal'
import { EmptyState } from '../../components/EmptyState'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { formatSlicingPresetKind, type SlicingPresetKind } from '../../lib/slicingPresetDirectory'
import {
  addLocalSlicingPresets,
  listLocalSlicingPresets,
  removeLocalSlicingPreset,
  type LocalSlicingPreset
} from './lib/localSlicingPresets'

/** Kind order matches the workspace manager's tabs, so the two read the same way. */
const KIND_ORDER: readonly SlicingPresetKind[] = ['machine', 'process', 'filament']

export function LocalSlicingPresetsDialog({ open, onClose }: {
  open: boolean
  /**
   * Callers refresh their slicing catalogue here: the editor renders from a snapshot taken at
   * open, so a preset added in this dialog reaches it only because closing says so.
   */
  onClose: () => void
}): JSX.Element {
  const { confirm } = usePromptDialog()
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Read once per change rather than on every render: localStorage is synchronous, and re-parsing
  // the store while the user scrolls the list is pure waste.
  const [presets, setPresets] = useState<LocalSlicingPreset[]>(() => listLocalSlicingPresets())
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const byKind = useMemo(() => {
    const grouped = new Map<SlicingPresetKind, LocalSlicingPreset[]>()
    for (const kind of KIND_ORDER) grouped.set(kind, [])
    for (const preset of presets) grouped.get(preset.kind)?.push(preset)
    return grouped
  }, [presets])

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    setUploading(true)
    try {
      // Re-uploading an edited preset REPLACES the stored one of the same kind and name, so there
      // is no conflict prompt to mirror from the workspace manager — see `addLocalSlicingPresets`.
      await addLocalSlicingPresets(file)
      setPresets(listLocalSlicingPresets())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That preset file could not be read.')
    } finally {
      setUploading(false)
    }
  }, [])

  const handleRemove = useCallback(async (preset: LocalSlicingPreset) => {
    const confirmed = await confirm({
      title: 'Remove this preset?',
      description: `“${preset.name}” will be removed from this browser. Uploading the file again restores it.`,
      confirmLabel: 'Remove',
      color: 'danger'
    })
    if (!confirmed) return
    setError(null)
    try {
      removeLocalSlicingPreset(preset.id)
      setPresets(listLocalSlicingPresets())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That preset could not be removed.')
    }
  }, [confirm])

  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 640, width: '100%' }}>
        <Typography level="h4">Slicing presets</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, px: 0 }}>
          <Stack spacing={1.5}>
            <Typography level="body-sm" textColor="text.tertiary">
              Upload BambuStudio presets for printer settings, material settings, and process settings.
              They are stored in this browser only and never leave your machine.
            </Typography>

            <Card variant="outlined">
              <CardContent>
                <Stack spacing={1.25}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    justifyContent="space-between"
                    alignItems={{ xs: 'stretch', sm: 'flex-end' }}
                  >
                    <Stack spacing={0.5}>
                      <Typography level="title-sm">Upload BambuStudio presets</Typography>
                      <Typography level="body-sm" textColor="text.tertiary">
                        Upload `.json`, `.bbscfg`, `.bbsflmt`, or preset `.zip` exports. Preset kinds are
                        auto-detected from the file using BambuStudio&apos;s own preset rules.
                      </Typography>
                    </Stack>
                    {/* Never wraps: the description beside it already takes the slack. */}
                    <Button
                      loading={uploading}
                      onClick={() => inputRef.current?.click()}
                      sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                    >
                      Upload presets
                    </Button>
                  </Stack>
                  <Box
                    component="input"
                    type="file"
                    accept="application/json,.json,.bbscfg,.bbsflmt,.zip"
                    ref={inputRef}
                    sx={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      // Cleared before the async work so picking the SAME file again still fires.
                      event.currentTarget.value = ''
                      if (!file) return
                      void handleFile(file)
                    }}
                  />
                </Stack>
              </CardContent>
            </Card>

            {error && <Alert color="danger">{error}</Alert>}

            {presets.length === 0 ? (
              <EmptyState
                compact
                icon={<InventoryRoundedIcon />}
                title="No presets stored yet"
                description="Upload a BambuStudio preset to slice with your own printer, process, or material settings."
              />
            ) : (
              KIND_ORDER.map((kind) => {
                const kindPresets = byKind.get(kind) ?? []
                if (kindPresets.length === 0) return null
                return (
                  <Stack key={kind} spacing={0.75}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <Typography level="title-sm">{formatSlicingPresetKind(kind)}</Typography>
                      <Chip size="sm" variant="soft">{kindPresets.length}</Chip>
                    </Stack>
                    <Sheet variant="outlined" sx={{ borderRadius: 'sm' }}>
                      <List size="sm">
                        {kindPresets.map((preset) => (
                          <ListItem
                            key={preset.id}
                            endAction={
                              <IconButton
                                size="sm"
                                variant="plain"
                                color="danger"
                                aria-label={`Remove preset ${preset.name}`}
                                onClick={() => void handleRemove(preset)}
                              >
                                <DeleteRoundedIcon fontSize="small" />
                              </IconButton>
                            }
                          >
                            <Typography level="body-sm" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                              {preset.name}
                            </Typography>
                          </ListItem>
                        ))}
                      </List>
                    </Sheet>
                  </Stack>
                )
              })
            )}
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button onClick={onClose}>Done</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

export default LocalSlicingPresetsDialog
