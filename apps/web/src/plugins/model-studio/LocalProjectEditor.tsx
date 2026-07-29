/**
 * The 3MF editor, hosted against a file on the user's own machine.
 *
 * This is the assembly point: it opens a file the user picked, builds the four local
 * implementations of the editor's seams — project source, import store, save target, materials —
 * and hands them to the SAME `EditorView` the library uses. There is deliberately no second editor
 * and no reduced feature set; what differs is only where bytes come from and go.
 *
 * Nothing is uploaded. The file is unzipped and parsed in the tab, edits bake in the tab, and a save
 * writes back through the handle the user granted (or downloads a copy where the browser has no
 * File System Access API).
 *
 * Hosts that mount this must provide a React Query client — `EditorView` loads through queries even
 * when the source is local. See the public shell.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, CardContent, Stack, Typography } from '@mui/joy'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import { LocalEditorSurface } from './LocalEditorSurface'
import { createLocalImportStore, type LocalImportStore } from './lib/localImportStore'
import { openClientThreeMfProject, type ClientThreeMfProject } from './lib/clientThreeMfProject'
import { ThreeMfArchiveError } from './lib/threeMfArchive'
import {
  openLocalProjectFile,
  pickLocalProjectFileViaInput,
  supportsFileSystemAccess,
  type LocalProjectFile
} from './lib/localProjectFile'

export interface LocalProjectEditorProps {
  /** Rendered under the picker before a project is open (the page's own copy / call to action). */
  intro?: React.ReactNode
}

export function LocalProjectEditor({ intro }: LocalProjectEditorProps) {
  const [project, setProject] = useState<ClientThreeMfProject | null>(null)
  const [projectFile, setProjectFile] = useState<LocalProjectFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  // The import store outlives individual saves and owns object URLs, so it is created once and
  // disposed on unmount rather than rebuilt per render.
  const importStoreRef = useRef<LocalImportStore | null>(null)
  if (!importStoreRef.current) importStoreRef.current = createLocalImportStore()
  const importStore = importStoreRef.current

  useEffect(() => () => {
    importStoreRef.current?.dispose()
    project?.dispose()
  }, [project])

  const open = useCallback(async (file: LocalProjectFile) => {
    setOpening(true)
    setError(null)
    try {
      const opened = await openClientThreeMfProject(file.blob as File)
      // Release the previous project's thumbnail URLs before dropping the reference.
      setProject((previous) => { previous?.dispose(); return opened })
      setProjectFile(file)
    } catch (caught) {
      setError(caught instanceof ThreeMfArchiveError || caught instanceof Error
        ? caught.message
        : 'That file could not be opened.')
    } finally {
      setOpening(false)
    }
  }, [])

  const pick = useCallback(async () => {
    setError(null)
    try {
      // With File System Access we keep a writable handle, so a later Save overwrites the same file.
      // Without it, fall back to a plain input, which yields bytes but no handle.
      if (supportsFileSystemAccess()) {
        const picked = await openLocalProjectFile()
        if (picked) await open(picked)
        return
      }
      const viaInput = await pickLocalProjectFileViaInput()
      if (viaInput) await open(viaInput)
    } catch (caught) {
      // Anything thrown here used to reject an un-awaited promise, so a picker that failed for any
      // reason looked exactly like a click that did nothing.
      setError(caught instanceof Error ? caught.message : 'That file could not be opened.')
    }
  }, [open])

  // Read through a ref so the save target (built in the editor surface) reads the current archive
  // without rebuilding when the project changes.
  const projectRef = useRef<ClientThreeMfProject | null>(null)
  projectRef.current = project
  // The OPENED archive, not null: the bake copies through every entry it does not rewrite, so baking
  // without it would save a 3MF containing only the scaffold — all geometry lost.
  const archiveRef = useCallback(() => projectRef.current?.archive ?? null, [])

  if (!project) {
    // Centred and width-constrained: the shell gives this branch the full viewport height, and a
    // full-bleed card with the rest of the page empty reads as a broken layout rather than a prompt.
    return (
      <Stack
        spacing={2}
        sx={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          maxWidth: 560,
          mx: 'auto',
          px: 2,
          justifyContent: 'center'
        }}
      >
        <Card variant="outlined" sx={{ borderStyle: 'dashed' }}>
          <CardContent sx={{ alignItems: 'center', gap: 1.5, py: 6 }}>
            <Typography level="title-md">Open a 3MF project</Typography>
            <Typography level="body-sm" textColor="text.tertiary" sx={{ textAlign: 'center' }}>
              Your file is opened by your browser and never leaves your machine.
            </Typography>
            <Button size="sm" startDecorator={<FolderOpenRoundedIcon />} loading={opening} onClick={() => void pick()}>
              Choose a file
            </Button>
            {error && <Typography level="body-sm" color="danger">{error}</Typography>}
          </CardContent>
        </Card>
        {intro}
      </Stack>
    )
  }

  return (
    <LocalEditorSurface
      project={project}
      projectFile={projectFile}
      importStore={importStore}
      archiveRef={archiveRef}
      onProjectFileChanged={setProjectFile}
      onClose={() => { project.dispose(); setProject(null); setProjectFile(null) }}
    />
  )
}

export default LocalProjectEditor
