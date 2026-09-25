/**
 * Contributed into the AMS / external-spool editors (`ams.slotEditor`,
 * `externalSpool.editor` plugin slots). Lets the user either pick a spool from
 * the filament library, filling the editor's filament fields and recording the
 * slot assignment, or save the currently-entered filament as a new library
 * spool loaded into this slot. Renders nothing if the host context is missing,
 * so the editors work unchanged when the plugin is disabled.
 *
 * The "pick from library" dialog reuses the Filament tab's directory controls
 * (search, sort, grouping, multi-select filters, list/icon view, pagination) via
 * the shared {@link useSpoolDirectory} hook + {@link SpoolDirectoryToolbar} +
 * {@link SpoolResults}, so picking a spool mirrors picking a file in the print
 * dialog.
 */
import { useMemo, useState } from 'react'
import { Box, Button, DialogTitle, ModalClose, Stack } from '@mui/joy'
import LibraryAddRoundedIcon from '@mui/icons-material/LibraryAddRounded'
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
import { extractErrorMessage, type FilamentSpool } from '@printstream/shared'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { EmptyState } from '../../components/EmptyState'
import { DialogSection } from '../../components/DialogSection'
import { toast } from '../../lib/toast'
import { useSpoolsQuery, useSpoolMutations } from './api'
import { FilamentSpoolIcon } from '../../components/FilamentSpoolIcon'
import { SpoolList } from './SpoolList'
import { SpoolGrid } from './SpoolGrid'
import { SpoolDirectoryToolbar } from './SpoolDirectoryToolbar'
import { SpoolResults } from './SpoolResults'
import { useSpoolDirectory } from './useSpoolDirectory'
import { SPOOL_PICKER_PREFS_KEY } from './constants'
import { spoolTitle } from './filters'

type ApplyValues = { brand?: string | null; colorName?: string | null; filamentType?: string | null; materialSubtype?: string | null; colorHex?: string | null; trayInfoIdx?: string | null; spoolLabel?: string }

type SlotContext = {
  /** Hosts may place the library picker and save action on opposite sides of their fields. */
  action?: unknown
  printerId?: unknown
  amsId?: unknown
  slotId?: unknown
  currentValues?: { brand?: unknown; materialSubtype?: unknown; colorName?: unknown; filamentType?: unknown; colorHex?: unknown; trayInfoIdx?: unknown }
  onApplyFilament?: unknown
}

const HEX = /^#[0-9A-Fa-f]{6}$/

export function SlotEditorActions(props: SlotContext) {
  const printerId = typeof props.printerId === 'string' ? props.printerId : null
  const amsId = typeof props.amsId === 'number' ? props.amsId : null
  const slotId = typeof props.slotId === 'number' ? props.slotId : null
  const onApply = typeof props.onApplyFilament === 'function'
    ? (props.onApplyFilament as (values: ApplyValues) => void)
    : null
  const current = props.currentValues ?? {}
  const currentType = typeof current.filamentType === 'string' ? current.filamentType : null
  const currentColor = typeof current.colorHex === 'string' ? current.colorHex : null
  const currentPreset = typeof current.trayInfoIdx === 'string' ? current.trayInfoIdx : null

  const [pickerOpen, setPickerOpen] = useState(false)
  const spoolsQuery = useSpoolsQuery()
  const { create, assign } = useSpoolMutations()
  const spools = useMemo(
    () => (spoolsQuery.data ?? []).filter((spool) => spool.archivedAt == null),
    [spoolsQuery.data]
  )
  const directory = useSpoolDirectory(spools, { storageKey: SPOOL_PICKER_PREFS_KEY })

  if (!printerId || amsId == null) return null

  const assignInput = { printerId, amsId, slotId }

  const pickSpool = async (spool: FilamentSpool) => {
    try {
      await assign.mutateAsync({ id: spool.id, input: assignInput })
      onApply?.({ brand: spool.brand, colorName: spool.colorName, filamentType: spool.filamentType, materialSubtype: spool.materialSubtype, colorHex: spool.colorHex, trayInfoIdx: spool.trayInfoIdx, spoolLabel: spoolTitle(spool) })
      toast.success(`Loaded ${spoolTitle(spool)} here`)
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Could not record the spool assignment.'))
    }
    setPickerOpen(false)
  }

  const saveCurrent = async () => {
    try {
      const created = await create.mutateAsync({
        filamentType: currentType ?? 'PLA',
        brand: typeof current.brand === 'string' ? current.brand : null,
        materialSubtype: typeof current.materialSubtype === 'string' ? current.materialSubtype : null,
        colorName: typeof current.colorName === 'string' ? current.colorName : null,
        colorHex: currentColor && HEX.test(currentColor) ? currentColor : null,
        trayInfoIdx: currentPreset || null
      })
      await assign.mutateAsync({ id: created.id, input: assignInput })
      onApply?.({ brand: created.brand, colorName: created.colorName, filamentType: created.filamentType, materialSubtype: created.materialSubtype, colorHex: created.colorHex, trayInfoIdx: created.trayInfoIdx, spoolLabel: spoolTitle(created) })
      toast.success('Saved to filament library and loaded here')
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Could not save the spool.'))
    }
  }

  const renderRows = (items: FilamentSpool[]) => directory.effectiveViewMode === 'list'
    ? <SpoolList spools={items} onPick={(spool) => void pickSpool(spool)} />
    : <SpoolGrid spools={items} onPick={(spool) => void pickSpool(spool)} />

  return (
    <Box
      sx={props.action === 'pick' || props.action === 'save' ? {} : {
        display: 'flex',
        gap: 1,
        flexWrap: 'wrap',
        p: 1,
        borderRadius: 'sm',
        bgcolor: 'background.level1'
      }}
    >
      {props.action === 'pick' ? (
        <DialogSection title="Filament library">
          <Button fullWidth size="sm" variant="soft" startDecorator={<Inventory2RoundedIcon />} onClick={() => setPickerOpen(true)}>
            Pick from library
          </Button>
        </DialogSection>
      ) : props.action !== 'save' && <Button size="sm" variant="soft" startDecorator={<Inventory2RoundedIcon />} onClick={() => setPickerOpen(true)}>
        Pick from library
      </Button>}
      {props.action !== 'pick' && <Button size="sm" variant="plain" startDecorator={<LibraryAddRoundedIcon />} loading={create.isPending} onClick={() => void saveCurrent()}>
        Save to library
      </Button>}

      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)}>
        <ScrollableModalDialog variant="outlined" sx={{ width: { xs: '100%', sm: 720 } }}>
          <ModalClose />
          <DialogTitle>Choose a spool</DialogTitle>
          <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
            <Stack spacing={1.5} sx={{ minWidth: 0 }}>
              <SpoolDirectoryToolbar directory={directory} compactControls pinnable={false} />
              <SpoolResults
                directory={directory}
                hasAnySpools={spools.length > 0}
                loading={spoolsQuery.isLoading}
                renderRows={renderRows}
                emptyState={
                  <EmptyState
                    icon={<FilamentSpoolIcon />}
                    title="No spools yet"
                    description="Add a spool from Filament or load one into an AMS."
                    compact
                  />
                }
                noMatchState={
                  <EmptyState icon={<FilamentSpoolIcon />} title="No matching spools" description="Try adjusting your search or filters." compact />
                }
              />
            </Stack>
          </ScrollableDialogBody>
          <Stack direction="row" justifyContent="flex-end" sx={{ pt: 1 }}>
            <Button variant="plain" color="neutral" onClick={() => setPickerOpen(false)}>Close</Button>
          </Stack>
        </ScrollableModalDialog>
      </Modal>
    </Box>
  )
}
