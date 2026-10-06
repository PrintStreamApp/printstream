/**
 * Owns STL and vanilla 3MF export from the editor's live scene.
 * The session owns selection, the active plate, and the destination dialog; this hook reads
 * live groups at invocation time and keeps downloads and library uploads on one export path.
 * Project 3MF export remains in the save flow because it preserves project metadata.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import * as THREE from 'three'
import { extractErrorMessage } from '@printstream/shared'
import { downloadBlob } from '../../lib/downloadBlob'
import { enqueueLibraryUploads } from '../../lib/libraryUploadQueue'
import { toast } from '../../lib/toast'
import { addedPartHostId, effectiveAddedParts, type EditorInstance, type EditorState } from './lib/editorModel'
import type { PartMember } from './lib/selectionModel'
import {
  buildObjectStl,
  buildObjectsStl,
  buildSelectedPartsStl,
  groupHasExcludedVolumes,
  partsExportName,
  stlExportBaseName,
  stlExportFileName
} from './lib/objectExport'
import { buildGenericThreeMf, genericThreeMfExportFileName } from './lib/genericThreeMfExport'

/** A pending destination-dialog request; project export is handled by the editor save flow. */
export type EditorExportRequest =
  | { kind: 'object'; key: string }
  | { kind: 'project'; key: string }
  | { kind: 'merged'; keys: ReadonlyArray<string> }
  | { kind: 'separate'; keys: ReadonlyArray<string> }
  | { kind: 'generic3mf'; keys: ReadonlyArray<string> }
  | { kind: 'parts'; ownerId: number; members: ReadonlyArray<PartMember> }

interface EditorObjectExportOptions {
  activePlateIndex: number
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  exportRequest: EditorExportRequest | null
  setExportRequest: Dispatch<SetStateAction<EditorExportRequest | null>>
  saveAsBridgeId: string | null
}

/** Build and deliver object exports without modifying the editor project or its history. */
export function useEditorObjectExport({
  activePlateIndex,
  stateRef,
  groupByKeyRef,
  exportRequest,
  setExportRequest,
  saveAsBridgeId
}: EditorObjectExportOptions) {
  /** Active-plate instances + live render groups for the given keys (missing entries dropped). */
  const exportMembersFor = useCallback((keys: ReadonlyArray<string>) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    return keys
      .map((key) => ({ instance: plate?.instances.find((entry) => entry.key === key), group: groupByKeyRef.current.get(key) }))
      .filter((member): member is { instance: EditorInstance; group: THREE.Group } => Boolean(member.instance && member.group))
  }, [activePlateIndex, stateRef, groupByKeyRef])

  /**
   * Build ONE STL for the given objects (BambuStudio's "Export as one STL"): model
   * parts merged with world placement baked (a multi-object selection keeps its
   * relative layout), re-centred on the origin. Helper volumes (negative parts,
   * modifiers, support blockers/enforcers) are dropped, there is no client-side mesh
   * boolean, so `droppedVolumes` lets the caller tell the user. Returns null (with an
   * error toast) when nothing solid remains, e.g. every part is a modifier.
   */
  const buildSelectionStl = useCallback((keys: ReadonlyArray<string>): { stl: ArrayBuffer; name: string; droppedVolumes: boolean } | null => {
    const members = exportMembersFor(keys)
    if (members.length === 0) return null
    const stl = buildObjectsStl(members.map((member) => member.group))
    if (!stl) {
      toast.error(members.length === 1
        ? `${members[0]!.instance.name} has no solid geometry to export.`
        : 'The selected objects have no solid geometry to export.')
      return null
    }
    return { stl, name: members[0]!.instance.name, droppedVolumes: members.some((member) => groupHasExcludedVolumes(member.group)) }
  }, [exportMembersFor])

  /**
   * Build one STL PER object (BambuStudio's "Export as STLs…"), each named after its
   * object with a " (2)"-style suffix deduping repeats. Objects with no solid geometry
   * are skipped; null (with an error toast) when nothing at all can be exported.
   */
  const buildSelectionStlFiles = useCallback((keys: ReadonlyArray<string>): Array<{ fileName: string; stl: ArrayBuffer; droppedVolumes: boolean }> | null => {
    const members = exportMembersFor(keys)
    if (members.length === 0) return null
    const nameCounts = new Map<string, number>()
    const files: Array<{ fileName: string; stl: ArrayBuffer; droppedVolumes: boolean }> = []
    for (const member of members) {
      const stl = buildObjectStl(member.group)
      if (!stl) continue
      const base = stlExportBaseName(member.instance.name)
      const count = (nameCounts.get(base) ?? 0) + 1
      nameCounts.set(base, count)
      files.push({
        fileName: `${count === 1 ? base : `${base} (${count})`}.stl`,
        stl,
        droppedVolumes: groupHasExcludedVolumes(member.group)
      })
    }
    if (files.length === 0) {
      toast.error('The selected objects have no solid geometry to export.')
      return null
    }
    return files
  }, [exportMembersFor])

  /**
   * Build one STL for specific PARTS of one object (the part menu's export), including
   * a selected helper volume, since picking it is the deliberate ask. `ownerId` is the
   * part selection's object key: the Bambu object id, or an import's synthetic
   * `replacedObjectId` (the same ownership rule as part type/material changes).
   */
  const buildPartsExport = useCallback((ownerId: number, members: ReadonlyArray<PartMember>): { stl: ArrayBuffer; name: string; droppedVolumes: boolean } | null => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => addedPartHostId(entry) === ownerId)
    const group = instance ? groupByKeyRef.current.get(instance.key) : undefined
    if (!instance || !group) return null
    const stl = buildSelectedPartsStl(group, members)
    if (!stl) {
      toast.error('The selected parts have no geometry to export.')
      return null
    }
    const name = partsExportName(instance, members, effectiveAddedParts(stateRef.current, instance))
    return { stl, name, droppedVolumes: false }
  }, [activePlateIndex, stateRef, groupByKeyRef])

  const downloadExportedStl = useCallback((built: { stl: ArrayBuffer; name: string; droppedVolumes: boolean }) => {
    const fileName = stlExportFileName(built.name)
    downloadBlob(new Blob([built.stl], { type: 'application/octet-stream' }), fileName)
    if (built.droppedVolumes) {
      toast.warn(`Exported ${fileName}: negative, modifier, and support volumes are not included.`)
    } else {
      toast.success(`Exported ${fileName}.`)
    }
  }, [])

  const handleExportMergedDownload = useCallback((keys: ReadonlyArray<string>) => {
    const built = buildSelectionStl(keys)
    if (built) downloadExportedStl(built)
  }, [buildSelectionStl, downloadExportedStl])

  const handleExportSeparateDownload = useCallback((keys: ReadonlyArray<string>) => {
    const files = buildSelectionStlFiles(keys)
    if (!files) return
    for (const file of files) {
      downloadBlob(new Blob([file.stl], { type: 'application/octet-stream' }), file.fileName)
    }
    if (files.some((file) => file.droppedVolumes)) {
      toast.warn(`Exported ${files.length} STLs: negative, modifier, and support volumes are not included.`)
    } else {
      toast.success(`Exported ${files.length} STLs.`)
    }
  }, [buildSelectionStlFiles])

  const handleExportPartsDownload = useCallback((ownerId: number, members: ReadonlyArray<PartMember>) => {
    const built = buildPartsExport(ownerId, members)
    if (built) downloadExportedStl(built)
  }, [buildPartsExport, downloadExportedStl])

  /**
   * Build a vanilla 3MF for the given objects (BambuStudio's "Export Generic 3MF"), each object a
   * separately named solid in ONE file.
   *
   * Async where the STL builders are not, because the archive is deflated off the main thread
   * (`zipArchiveEntries`); a plate's worth of geometry zipped inline is a visible freeze.
   */
  const buildSelectionGenericThreeMf = useCallback(async (
    keys: ReadonlyArray<string>
  ): Promise<{ bytes: Uint8Array; name: string; droppedVolumes: boolean } | null> => {
    const members = exportMembersFor(keys)
    if (members.length === 0) return null
    const bytes = await buildGenericThreeMf(members.map((member) => ({ name: member.instance.name, group: member.group })))
    if (!bytes) {
      toast.error(members.length === 1
        ? `${members[0]!.instance.name} has no solid geometry to export.`
        : 'The selected objects have no solid geometry to export.')
      return null
    }
    return { bytes, name: members[0]!.instance.name, droppedVolumes: members.some((member) => groupHasExcludedVolumes(member.group)) }
  }, [exportMembersFor])

  const handleExportGenericThreeMfDownload = useCallback((keys: ReadonlyArray<string>) => {
    // Every sibling STL export is synchronous and cannot fail this way; this one deflates the
    // archive off-thread, so it has two rejection paths (a worker zip failure that does not fall
    // back, and the writer's own "no solid had usable geometry"). Unhandled, both leave the user
    // with no file, no toast and no error, i.e. a menu item that silently does nothing.
    void (async () => {
      try {
        const built = await buildSelectionGenericThreeMf(keys)
        if (!built) return
        const fileName = genericThreeMfExportFileName(built.name)
        downloadBlob(new Blob([built.bytes as BlobPart], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }), fileName)
        // The same caveat the STL export reports, and for the same reason: no client-side mesh
        // boolean, so a negative volume cannot be applied and is left out rather than written solid.
        if (built.droppedVolumes) {
          toast.warn(`Exported ${fileName}: negative, modifier, and support volumes are not included.`)
        } else {
          toast.success(`Exported ${fileName}.`)
        }
      } catch (error) {
        toast.error(`Could not export the 3MF: ${extractErrorMessage(error, 'the file could not be written')}`)
      }
    })()
  }, [buildSelectionGenericThreeMf])

  /** Destination-dialog submit for export-to-library: upload through the shared queue (its toast reports progress). */
  const handleExportToLibrarySubmit = useCallback((outputFileName: string | null, outputFolderId: string | null) => {
    const request = exportRequest
    setExportRequest(null)
    if (!request) return
    const destination = { folderId: outputFolderId, bridgeId: saveAsBridgeId }
    if (request.kind === 'separate') {
      const files = buildSelectionStlFiles(request.keys)
      if (!files) return
      enqueueLibraryUploads(
        files.map((file) => ({ file: new File([file.stl], file.fileName, { type: 'application/octet-stream' }), folderSegments: [] })),
        destination
      )
      if (files.some((file) => file.droppedVolumes)) {
        toast.warn('Negative, modifier, and support volumes are not included in the exported STLs.')
      }
      return
    }
    if (!outputFileName) return
    if (request.kind === 'generic3mf') {
      // Async, unlike every sibling: the archive is deflated off the main thread. Fire-and-forget
      // because the upload queue owns the progress toast from here on -- but NOT unguarded: the
      // dialog has already closed by this point, so an unhandled rejection would leave the user
      // looking at a dismissed dialog and no file, with nothing said.
      void (async () => {
        try {
          const built = await buildSelectionGenericThreeMf(request.keys)
          if (!built) return
          const file = new File([built.bytes as BlobPart], `${outputFileName}.3mf`, {
            type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
          })
          enqueueLibraryUploads([{ file, folderSegments: [] }], destination)
          if (built.droppedVolumes) {
            toast.warn(`Exporting ${file.name}: negative, modifier, and support volumes are not included.`)
          }
        } catch (error) {
          toast.error(`Could not export the 3MF: ${extractErrorMessage(error, 'the file could not be written')}`)
        }
      })()
      return
    }
    // 'project' never lands here (the dialog dispatches it straight to the save hook),
    // but the narrowing treats both single-key kinds the same.
    const built = request.kind === 'parts'
      ? buildPartsExport(request.ownerId, request.members)
      : buildSelectionStl(request.kind === 'object' || request.kind === 'project' ? [request.key] : request.keys)
    if (!built) return
    const file = new File([built.stl], `${outputFileName}.stl`, { type: 'application/octet-stream' })
    enqueueLibraryUploads([{ file, folderSegments: [] }], destination)
    if (built.droppedVolumes) {
      toast.warn(`Exporting ${file.name}: negative, modifier, and support volumes are not included.`)
    }
  }, [exportRequest, setExportRequest, buildSelectionStlFiles, buildPartsExport, buildSelectionStl, buildSelectionGenericThreeMf, saveAsBridgeId])

  return {
    handleExportMergedDownload,
    handleExportSeparateDownload,
    handleExportPartsDownload,
    handleExportGenericThreeMfDownload,
    handleExportToLibrarySubmit
  }
}
