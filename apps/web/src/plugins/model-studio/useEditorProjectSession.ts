/**
 * Project-source and query lifecycle for one Model Studio editor session.
 *
 * The source owns one opened archive. React Query keys and cleanup stay here so
 * a save-close-reopen reads fresh bytes, while a host-supplied source and save
 * target retain their caller-owned lifetime. The component still coordinates
 * plate state, scene refs, and saving.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createDownloadProgressReporter } from './lib/editorPreparation'
import { useStrictModeSafeResourceDisposal } from './useStrictModeSafeResourceDisposal'
import { createArchiveProjectSource, type ArchiveProjectOpenPhase, type EditorProjectSource } from './lib/editorProjectSource'
import type { ModelFetchProgress } from './lib/modelFetch'
import { createApiSaveTarget, type EditorSaveTarget } from './lib/editorSaveTarget'
import type { EditorImportStore } from './lib/editorImportStore'

type Options = {
  baseFileId: string | null
  baseVersionId: string | null
  resourceBase: string
  hasNoBaseFile: boolean
  projectAuxiliariesOpen: boolean
  projectSourceProp?: EditorProjectSource
  importStore: EditorImportStore
  saveTarget?: EditorSaveTarget
}

/** Create or adopt a source, register its query set, and clean its session cache on close. */
export function useEditorProjectSession({
  baseFileId,
  baseVersionId,
  resourceBase,
  hasNoBaseFile,
  projectAuxiliariesOpen,
  projectSourceProp,
  importStore,
  saveTarget
}: Options) {
  const queryClient = useQueryClient()
  const [projectOpenPhase, setProjectOpenPhase] = useState<ArchiveProjectOpenPhase>(
    projectSourceProp ? 'reading-project' : 'loading-file'
  )
  const [projectDownloadProgress, setProjectDownloadProgress] = useState<ModelFetchProgress | null>(null)
  const reportProjectDownloadProgress = useMemo(
    () => createDownloadProgressReporter(setProjectDownloadProgress),
    []
  )
  const reportProjectOpenPhase = useCallback((phase: ArchiveProjectOpenPhase) => {
    setProjectOpenPhase(phase)
  }, [])
  // A save target that is not library-backed writes to the user's own file. There is no library
  // folder to choose and no "version" concept, so Save means "write it back" and Save-as means
  // "ask the OS where", never the library destination dialog.
  // Memoized on `resourceBase`: the source owns one downloaded archive, so an identity that
  // changed each render would re-download the project and re-key every query that depends on it.
  const projectSource = useMemo(
    () => projectSourceProp ?? createArchiveProjectSource(resourceBase, 'project.3mf', {
      onOpenPhase: reportProjectOpenPhase,
      onDownloadProgress: reportProjectDownloadProgress
    }),
    [projectSourceProp, reportProjectDownloadProgress, reportProjectOpenPhase, resourceBase]
  )
  // Read through a ref by the callbacks that must not re-create themselves when the source's
  // identity changes (the SVG reopen, which reads an archive entry on demand).
  const projectSourceRef = useRef(projectSource)
  projectSourceRef.current = projectSource
  // Only names the upload session: an addressed new version keeps the row's OWN name, precisely
  // because this session's copy of it may be stale.
  const projectNameRef = useRef('project.3mf')
  /**
   * The workspace save target is built here rather than defaulted inside `useEditorSave`, because it
   * needs the archive this session OPENED, which every bake authors
   * from, and the import store the `SceneEdit` refers to.
   *
   * Read through the refs so one target survives a re-render. The archive accessor is deliberately
   * not an async open: a bake must author from the bytes this session has been reading all along,
   * and re-fetching would author from whatever the file holds now, which after an earlier save is
   * this session's own output.
   */
  const workspaceSaveTarget = useMemo(
    () => createApiSaveTarget({
      archive: () => projectSourceRef.current.archive(),
      importStore,
      projectName: () => projectNameRef.current
    }),
    [importStore]
  )
  const effectiveSaveTarget = saveTarget ?? workspaceSaveTarget
  const savesToLocalFile = !effectiveSaveTarget.isLibraryBacked
  // Only dispose a source this hook created; a host that supplies one owns its lifetime
  // (same rule as `importStore`). Without this the archive and its plate-thumbnail object URLs
  // would outlive every editor open.
  useStrictModeSafeResourceDisposal(
    projectSource,
    projectSourceProp == null,
    (source) => { source.dispose?.() }
  )

  // Drop this session's cached view of the file when the editor closes.
  //
  // These caches are answered from an archive downloaded ONCE per session, so anything cached
  // after a save describes the pre-save bytes. Leaving it behind is what let a reopen (same page,
  // within staleTime) seed from the previous session's stale scene. Removing rather than
  // invalidating is the point: a later session must READ the file, not inherit a view of it.
  useEffect(() => () => {
    queryClient.removeQueries({ queryKey: ['library-editor-plates', baseFileId] })
    queryClient.removeQueries({ queryKey: ['library-editor-scene-initial', baseFileId] })
    queryClient.removeQueries({ queryKey: ['library-editor-scenes-rest', baseFileId] })
    queryClient.removeQueries({ queryKey: ['library-editor-auxiliaries', baseFileId] })
    // The file's own DTO goes too. Nothing invalidates this key (`library-files` does not prefix-match
    // `library-file`), so at a 60s staleTime a reopen inside that window inherits the PRE-save row,
    // including `currentVersionNumber`, which seeds the concurrent-save baseline. That made an
    // ordinary save-close-reopen-save loop accuse the user of overwriting their own previous save.
    queryClient.removeQueries({ queryKey: ['library-file', baseFileId] })
  }, [queryClient, baseFileId])
  const platesQuery = useQuery({
    queryKey: ['library-editor-plates', baseFileId, baseVersionId ?? 'current'],
    enabled: !hasNoBaseFile,
    queryFn: ({ signal }) => projectSource.loadIndex(signal),
    staleTime: 60_000
  })

  // The presets the project carries inside itself. `staleTime: Infinity` because they come from the
  // archive this session already holds and nothing outside the session can change them: the file
  // on disk is not re-read until the next open (see `in-memory-after-open`).
  const embeddedPresetsQuery = useQuery({
    queryKey: ['library-editor-embedded-presets', baseFileId, baseVersionId ?? 'current'],
    enabled: !hasNoBaseFile && typeof projectSource.loadEmbeddedPresets === 'function',
    queryFn: () => projectSource.loadEmbeddedPresets?.() ?? Promise.resolve([]),
    staleTime: Infinity
  })

  // The project's own settings, for the purge volumes the flushing dialog edits. Same
  // `staleTime: Infinity` reasoning as the embedded presets above: it comes from the archive this
  // session already holds, and the file is not re-read until the next open.
  const projectSettingsQuery = useQuery({
    queryKey: ['library-editor-project-settings', baseFileId, baseVersionId ?? 'current'],
    enabled: !hasNoBaseFile && typeof projectSource.loadProjectSettings === 'function',
    queryFn: () => projectSource.loadProjectSettings?.() ?? Promise.resolve(null),
    staleTime: Infinity
  })

  // Attachments can be large and are irrelevant to normal editing, so do not decode/base64 them
  // until the user opens their dialog. Until Apply, SceneEdit keeps this absent and an unrelated
  // save streams the archive entries through byte-for-byte.
  const projectAuxiliariesQuery = useQuery({
    queryKey: ['library-editor-auxiliaries', baseFileId, baseVersionId ?? 'current'],
    enabled: projectAuxiliariesOpen
      && !hasNoBaseFile
      && typeof projectSource.loadProjectAuxiliaries === 'function',
    queryFn: () => projectSource.loadProjectAuxiliaries?.() ?? Promise.reject(new Error('This project source cannot read attachments.')),
    staleTime: Infinity
  })

  return {
    projectOpenPhase,
    projectDownloadProgress,
    projectSource,
    projectSourceRef,
    projectNameRef,
    effectiveSaveTarget,
    savesToLocalFile,
    platesQuery,
    embeddedPresetsQuery,
    projectSettingsQuery,
    projectAuxiliariesQuery
  }
}
