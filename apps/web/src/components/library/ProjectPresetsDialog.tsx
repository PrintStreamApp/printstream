/**
 * View and remove the filament presets a project carries INSIDE itself — BambuStudio's "project
 * presets", the ones it shows in the material list suffixed `(<project>.3mf)`.
 *
 * These are ordinary project content, not a defect report: BambuStudio writes them whenever a slot
 * uses a preset the file needs to carry with it, and re-embeds every sidecar it finds on every save.
 * That means one can outlive whatever put it there, so a project accumulates presets nobody can see
 * or reach — hence a place to look at them and clear the ones nothing uses.
 *
 * A USED preset is listed but never removable: the slot naming it would be left pointing at a preset
 * that exists nowhere, which is the condition that makes BambuStudio fabricate a replacement. And
 * removal is explicit, never automatic — an embedded preset can be the only surviving record of
 * settings someone tuned, so an unreferenced one is still not ours to delete unasked
 * (`three-mf/embedded-presets.ts`).
 *
 * Opened from the Materials header; the editor owns the removals (undoable, applied on save).
 */
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import Button from '@mui/joy/Button'
import Chip from '@mui/joy/Chip'
import DialogActions from '@mui/joy/DialogActions'
import IconButton from '@mui/joy/IconButton'
import List from '@mui/joy/List'
import ListItem from '@mui/joy/ListItem'
import Stack from '@mui/joy/Stack'
import Tooltip from '@mui/joy/Tooltip'
import Typography from '@mui/joy/Typography'
import type { EmbeddedProjectPreset } from '@printstream/shared/three-mf'
import { BackAwareModal } from '../BackAwareModal'
import { EmptyState } from '../EmptyState'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'

export interface ProjectPresetsDialogProps {
  open: boolean
  onClose: () => void
  presets: readonly EmbeddedProjectPreset[]
  /** Remove one by its archive entry path. Undoable, and applied on the next save. */
  onRemove: (entryPath: string) => void
}

/** A preset with no readable name still has to be identifiable, or its row is unactionable. */
function presetLabel(preset: EmbeddedProjectPreset): string {
  if (preset.name.length > 0) return preset.name
  const index = preset.entryPath.match(/_(\d+)\.config$/)?.[1]
  return index ? `Unreadable preset ${index}` : 'Unreadable preset'
}

export function ProjectPresetsDialog({ open, onClose, presets, onRemove }: ProjectPresetsDialogProps) {
  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 560, width: '100%' }}>
        <Typography level="h4">Presets in this project</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, px: 0 }}>
          <Stack spacing={1.5}>
            <Typography level="body-sm" textColor="text.tertiary">
              Presets saved inside this project file. BambuStudio shows these in its material list and keeps them
              in the file. One a material still uses can only be removed once that material points at another preset.
            </Typography>
            {presets.length === 0 ? (
              <EmptyState
                icon={<InventoryRoundedIcon />}
                title="No presets saved in this project"
                description="Its materials all use presets from your catalogue."
              />
            ) : (
              <List size="sm" sx={{ '--ListItem-minHeight': '3rem' }}>
                {presets.map((preset) => (
                  <ListItem key={preset.entryPath} sx={{ gap: 1 }}>
                    <Stack sx={{ minWidth: 0, flex: 1 }}>
                      <Typography level="body-sm" noWrap title={presetLabel(preset)}>{presetLabel(preset)}</Typography>
                      {preset.inherits && (
                        <Typography level="body-xs" textColor="text.tertiary" noWrap title={preset.inherits}>
                          Based on {preset.inherits}
                        </Typography>
                      )}
                    </Stack>
                    <Chip size="sm" variant="soft" color={preset.used ? 'primary' : 'neutral'}>
                      {preset.used ? 'In use' : 'Unused'}
                    </Chip>
                    <Tooltip title={preset.used
                      ? 'A material in this project uses this preset — point that material at another preset first'
                      : 'Remove this preset from the project file'}>
                      <span>
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="danger"
                          disabled={preset.used}
                          onClick={() => onRemove(preset.entryPath)}
                          aria-label={`Remove project preset ${presetLabel(preset)}`}
                        >
                          <DeleteRoundedIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </ListItem>
                ))}
              </List>
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
