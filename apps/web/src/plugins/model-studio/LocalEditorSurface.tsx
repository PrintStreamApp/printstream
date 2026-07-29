/**
 * Mounts `EditorView` for an open local project, wiring the local seams plus the local slice-settings
 * controller. Kept separate from {@link LocalProjectEditor} so the controller's hooks (catalogue
 * queries, settings state) run only while a project is actually open — a hook cannot be called
 * conditionally, so the "no project yet" branch must not host it.
 *
 * Slicing is deliberately NOT wired here (`onSlice` omitted): a browser cannot reach printers or the
 * slicer, so the editor renders its Slice control disabled. Everything else — arrange, transform,
 * materials, process presets, plate/nozzle/model — works against the settings sidebar the controller
 * feeds. Materials are derived by `EditorView` from the controller (no separate `materials` prop), so
 * a material pick or recolour in the sidebar updates the 3D view live.
 */
import { Suspense, lazy, useMemo } from 'react'
import { Box } from '@mui/joy'
import EditorView from './EditorView'
import { useMobileViewport } from '../../components/useMobileViewport'
import { LazyDialogFallback } from '../../components/LazyDialogFallback'
import { createLocalProjectSource } from './lib/editorProjectSource'
import { createLocalSaveTarget } from './lib/localSaveTarget'
import type { LocalImportStore } from './lib/localImportStore'
import type { ClientThreeMfProject } from './lib/clientThreeMfProject'
import type { LocalProjectFile } from './lib/localProjectFile'
import { useLocalSliceSettingsController } from './useLocalSliceSettingsController'

// Global process "tune" dialog. The library host renders this from its still-mounted slice dialog;
// a server-less host has no such wrapper, so it renders it here, wired to the local controller +
// anonymous resolver. (Per-object process dialogs are rendered by EditorView itself.)
const ProcessSettingsDialog = lazy(() => import('../../components/ProcessSettingsDialog'))

export interface LocalEditorSurfaceProps {
  project: ClientThreeMfProject
  projectFile: LocalProjectFile | null
  importStore: LocalImportStore
  /** Live handle to the current archive bytes (the bake copies through un-rewritten entries). */
  archiveRef: () => ClientThreeMfProject['archive'] | null
  onProjectFileChanged: (file: LocalProjectFile | null) => void
  onClose: () => void
}

export function LocalEditorSurface({ project, projectFile, importStore, archiveRef, onProjectFileChanged, onClose }: LocalEditorSurfaceProps) {
  const isMobileViewport = useMobileViewport()
  const projectSource = useMemo(() => createLocalProjectSource(project), [project])
  const saveTarget = useMemo(
    () => createLocalSaveTarget({
      archive: archiveRef,
      importStore,
      projectFile: () => projectFile,
      onProjectFileChanged
    }),
    [archiveRef, importStore, projectFile, onProjectFileChanged]
  )
  const { controller, targetPrinterModel, resolveProcessConfig, processSettingsDialogOpen, processBaselineNote } = useLocalSliceSettingsController({ project, isMobileViewport, onClose })

  return (
    <Box sx={{ height: '100%', minHeight: 0 }}>
      <EditorView
        baseFileId={null}
        projectSource={projectSource}
        importStore={importStore}
        saveTarget={saveTarget}
        sliceConfig={controller}
        // Drives the bed + zones and follows a model switch, exactly as the library host does; and
        // fetch the plate mesh from the anonymous catalogue so it loads with no workspace.
        targetPrinterModel={targetPrinterModel}
        bedModelPath="/api/public/slicing/bed-model"
        resolveProcessConfig={resolveProcessConfig}
        presentation="fullscreen"
        onClose={onClose}
      />
      {processSettingsDialogOpen && controller.selectedProcessProfile && (
        <Suspense fallback={<LazyDialogFallback label="Opening settings…" />}>
          <ProcessSettingsDialog
            open
            onClose={() => controller.setProcessSettingsDialogOpen(false)}
            slicerTargetId={controller.selectedSlicerTargetId}
            processProfileId={controller.selectedProcessProfile.id}
            processProfileName={controller.selectedProcessProfile.name}
            // Project presets resolve from the in-tab 3MF via resolveConfig, so no server file id.
            sourceFileId={null}
            initialOverrides={controller.processSettingOverrides}
            visibilityContext={{ printerModel: controller.selectedPrinterModel }}
            profileOptions={controller.compatibleProcessProfiles}
            applyScope="project"
            resolveConfig={resolveProcessConfig}
            baselineNote={processBaselineNote ?? undefined}
            onProfileChange={(profileId, carryOverrides) => {
              controller.processProfileSelectionTouchedRef.current = true
              controller.setProcessProfileId(profileId)
              controller.setProcessSettingOverrides(carryOverrides)
            }}
            onApply={(overrides) => controller.setProcessSettingOverrides(overrides)}
          />
        </Suspense>
      )}
    </Box>
  )
}

export default LocalEditorSurface
