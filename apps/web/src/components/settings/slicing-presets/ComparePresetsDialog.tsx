/**
 * Two presets of one kind, side by side (BambuStudio's `DiffPresetDialog`).
 *
 * OWNS the surface only: it resolves both presets through the SAME single-owner resolvers every
 * settings dialog uses (`workspaceResolvers.test.ts` fails the build on a second fetcher for those
 * routes), hands the pair to `presetDiff.ts`, and renders the rows.
 *
 * READ-ONLY, deliberately, and for the reason the parameter table is: the write side has rules this
 * surface would have to re-implement to offer an edit here (a process override lives on the slice
 * controller, a filament one is per-variant, a machine one is per-column over vectors indexed by
 * different things per page). Comparing is the question being asked; editing is one click away in
 * the dialog that already owns it.
 *
 * Both presets must be the same KIND. That is enforced by the caller (the compare button only
 * appears for a two-preset same-kind selection) because a cross-kind diff has no shared catalog to
 * compare against, so there is no meaningful row it could produce.
 */
import {
  Alert,
  Box,
  Chip,
  DialogContent,
  DialogTitle,
  ModalClose,
  ModalDialog,
  Stack,
  Table,
  Typography
} from '@mui/joy'
import {
  filamentSettingsCatalog,
  machineSettingsCatalog,
  processSettingsCatalog,
  applyProcessConfigDefaults,
  extractErrorMessage,
  type ProcessConfig,
  type ProcessSettingsCatalog,
  type SlicingPresetKind,
  type SlicingPresetSummary
} from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { BackAwareModal } from '../../BackAwareModal'
import { EmptyState } from '../../EmptyState'
import { ListSkeleton } from '../../ListSkeleton'
import { useEffectiveSlicerDeveloperMode } from '../../../lib/slicerDeveloperMode'
import { resolveWorkspaceProcessConfig } from '../../workspaceProcessResolver'
import { resolveWorkspaceMachineConfig } from '../../workspaceMachineResolver'
import { resolveWorkspaceFilamentConfig } from '../../library/workspaceFilamentResolver'
import { buildPresetDiff } from '../presetDiff'
import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded'

const CATALOG_BY_KIND: Record<SlicingPresetKind, ProcessSettingsCatalog> = {
  process: processSettingsCatalog,
  filament: filamentSettingsCatalog,
  machine: machineSettingsCatalog
}

/** Resolve one preset's full config through its kind's own owner module. */
async function resolvePresetConfig(
  kind: SlicingPresetKind,
  profileId: string,
  targetId: string,
  signal: AbortSignal
): Promise<Record<string, string | string[]>> {
  if (kind === 'process') {
    const resolved = await resolveWorkspaceProcessConfig({ processProfileId: profileId, targetId, sourceFileId: null }, { signal })
    return resolved.config
  }
  if (kind === 'machine') {
    const resolved = await resolveWorkspaceMachineConfig({ machineProfileId: profileId, targetId }, { signal })
    // The machine route types its config as the looser `ProfileRecord`; the values are serialized
    // preset values like the other two. Same cast `MachineSettingsDialog` makes on this response.
    return resolved.config as ProcessConfig
  }
  const resolved = await resolveWorkspaceFilamentConfig(
    { filamentProfileId: profileId, targetId, sourceFileId: null, projectFilamentId: null },
    { signal }
  )
  return resolved.config
}

export function ComparePresetsDialog({
  kind,
  left,
  right,
  slicerTargetId,
  onClose
}: {
  kind: SlicingPresetKind
  left: SlicingPresetSummary
  right: SlicingPresetSummary
  slicerTargetId: string
  onClose: () => void
}) {
  const showDeveloperOptions = useEffectiveSlicerDeveloperMode()
  const comparison = useQuery({
    // Keyed on both ids AND the target: a preset's resolved values depend on the engine it is
    // resolved against, so a target switch must not serve the previous engine's answer. The
    // developer tier is in the key for the same reason one step later: it decides which rows are
    // rendered and which are only counted, so a cached diff from the other tier is the wrong answer.
    queryKey: ['slicing-preset-compare', kind, left.id, right.id, slicerTargetId, showDeveloperOptions],
    enabled: Boolean(slicerTargetId),
    queryFn: async ({ signal }) => {
      const catalog = CATALOG_BY_KIND[kind]
      const [leftConfig, rightConfig] = await Promise.all([
        resolvePresetConfig(kind, left.id, slicerTargetId, signal),
        resolvePresetConfig(kind, right.id, slicerTargetId, signal)
      ])
      // Defaults are laid over BOTH sides, as the settings dialogs do before showing a value. A
      // preset that omits a key and one that states the key's own default behave identically, so
      // comparing the raw configs would report a difference that does not exist and, worse, one
      // the user cannot see when they open either preset to check.
      return buildPresetDiff(
        catalog,
        applyProcessConfigDefaults(leftConfig, catalog),
        applyProcessConfigDefaults(rightConfig, catalog),
        { showDeveloperOptions }
      )
    }
  })

  const diff = comparison.data

  return (
    <BackAwareModal open onClose={onClose}>
      <ModalDialog variant="outlined" sx={{ width: 'min(900px, 100%)' }}>
        <ModalClose />
        <DialogTitle>Compare presets</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip size="sm" variant="soft" color="primary">{left.name}</Chip>
              <CompareArrowsRoundedIcon fontSize="small" />
              <Chip size="sm" variant="soft" color="warning">{right.name}</Chip>
            </Stack>

            {!slicerTargetId && (
              // A disabled TanStack query reports `isPending` forever, so without this the dialog
              // parks on the skeleton with no error and no explanation. The caller also disables the
              // button, but the target can be empty for other reasons (capabilities still loading,
              // a deployment with no engine at all) and the dialog must say so for itself.
              <Alert color="warning">
                No slicer engine is available to resolve these presets against.
              </Alert>
            )}
            {comparison.isError && <Alert color="danger">{extractErrorMessage(comparison.error)}</Alert>}
            {slicerTargetId && comparison.isPending && <ListSkeleton rows={5} />}

            {diff && diff.rows.length === 0 && (
              <EmptyState
                compact
                icon={<CompareArrowsRoundedIcon />}
                title="These presets match"
                description="Every setting the catalog shows has the same value in both."
              />
            )}

            {diff && diff.rows.length > 0 && (
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="sm" stickyHeader sx={{ minWidth: 560 }}>
                  <thead>
                    <tr>
                      <th style={{ width: '40%' }}>Setting</th>
                      <th style={{ width: '30%' }}>{left.name}</th>
                      <th style={{ width: '30%' }}>{right.name}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.rows.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <Typography level="body-sm">{row.label}</Typography>
                          <Typography level="body-xs" textColor="text.tertiary">
                            {row.page} › {row.group}
                          </Typography>
                        </td>
                        <td><Typography level="body-sm">{row.left}</Typography></td>
                        <td><Typography level="body-sm">{row.right}</Typography></td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Box>
            )}

            {diff && diff.skippedKeyCount > 0 && (
              // Said out loud rather than hidden: BambuStudio drops these from its own diff
              // silently, which lets the surface imply two presets match when they do not.
              <Typography level="body-xs" textColor="text.tertiary">
                {diff.skippedKeyCount} other {diff.skippedKeyCount === 1 ? 'value differs' : 'values differ'} in
                settings this editor does not show.
              </Typography>
            )}
          </Stack>
        </DialogContent>
      </ModalDialog>
    </BackAwareModal>
  )
}

export default ComparePresetsDialog
