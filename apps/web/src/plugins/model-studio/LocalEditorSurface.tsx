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
 *
 * This host renders the three surfaces that have no still-mounted slice dialog to render them from:
 * the global process tune dialog, the per-material tune dialog, and the slicing-preset manager. The
 * manager is the BROWSER-STORAGE one — the workspace manager's every request needs a tenant, so
 * handing the editor that one is what made "Manage" report a permission error here.
 */
import { Suspense, lazy, useCallback, useMemo, useRef } from 'react'
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

// Global process + per-material "tune" dialogs. The library host renders these from its
// still-mounted slice dialog; a server-less host has no such wrapper, so it renders them here,
// wired to the local controller + anonymous resolvers. (Per-object process dialogs are rendered by
// EditorView itself.)
const ProcessSettingsDialog = lazy(() => import('../../components/ProcessSettingsDialog'))
const FilamentSettingsDialog = lazy(() => import('../../components/library/FilamentSettingsDialog'))
// The preset manager stores into this browser, never a workspace. Lazy for the same reason the
// tune dialogs are: it is opened rarely and pulls in the upload/parse path.
const LocalSlicingPresetsDialog = lazy(() => import('./LocalSlicingPresetsDialog'))

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
  const {
    controller,
    targetPrinterModel,
    resolveProcessConfig,
    resolveFilamentConfig,
    installedFilamentPresets,
    processSettingsDialogOpen,
    filamentSettingsFilamentId,
    setFilamentSettingsFilamentId,
    setFilamentSettingOverridesById,
    processBaselineNote
  } = useLocalSliceSettingsController({ project, isMobileViewport, onClose })

  // Read through a ref so the catalogue settling does not rebuild the save target (which would
  // otherwise be a new object on every catalogue update, for a value only a save ever reads).
  const filamentPresetsRef = useRef(installedFilamentPresets)
  filamentPresetsRef.current = installedFilamentPresets
  const saveTarget = useMemo(
    () => createLocalSaveTarget({
      archive: archiveRef,
      importStore,
      projectFile: () => projectFile,
      onProjectFileChanged,
      filamentPresets: () => filamentPresetsRef.current
    }),
    [archiveRef, importStore, projectFile, onProjectFileChanged]
  )

  const presetManager = useCallback(
    (managerProps: { open: boolean; onClose: () => void }) => (
      <Suspense fallback={<LazyDialogFallback label="Opening presets…" />}>
        <LocalSlicingPresetsDialog {...managerProps} />
      </Suspense>
    ),
    []
  )

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
        presetManager={presetManager}
        hosting="page"
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
      {filamentSettingsFilamentId != null && (() => {
        const option = controller.materialOptions.find(
          (entry) => entry.id === controller.filamentMaterialOptionIds[filamentSettingsFilamentId]
        )
        // Resolve the material's slicing-preset id the same way the tune button does — see the
        // button in SliceSettingsPanel. No id means nothing to base an edit on.
        const profileId = option?.profileId
          ?? (option?.id.startsWith('profile:') ? option.id.slice('profile:'.length) : null)
        if (!profileId) return null
        return (
          <Suspense fallback={<LazyDialogFallback label="Opening settings…" />}>
            <FilamentSettingsDialog
              open
              onClose={() => setFilamentSettingsFilamentId(null)}
              slicerTargetId={controller.selectedSlicerTargetId}
              filamentProfileId={profileId}
              filamentProfileName={option?.presetLabel ?? option?.material ?? option?.label ?? `Material ${filamentSettingsFilamentId}`}
              filamentPresetFullName={option?.profileId ? option.material : null}
              // Project filaments resolve from the in-tab 3MF via resolveConfig, so no server file id.
              sourceFileId={null}
              projectFilamentId={filamentSettingsFilamentId}
              initialOverrides={controller.filamentSettingOverridesById[filamentSettingsFilamentId] ?? {}}
              // No "Update preset": saving one needs a workspace to store it in. A built-in stays
              // read-only here exactly as it is signed in.
              applyScope="project"
              resolveConfig={resolveFilamentConfig}
              onApply={(overrides) => {
                controller.materialEditListenerRef.current?.()
                setFilamentSettingOverridesById((prev) => {
                  const next = { ...prev }
                  if (Object.keys(overrides).length === 0) delete next[filamentSettingsFilamentId]
                  else next[filamentSettingsFilamentId] = overrides
                  return next
                })
              }}
            />
          </Suspense>
        )
      })()}
    </Box>
  )
}

export default LocalEditorSurface
