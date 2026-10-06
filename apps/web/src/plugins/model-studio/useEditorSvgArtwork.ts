/**
 * Owns the SVG tool's file, parsed artwork, and re-edit session. Its archive source is the same
 * pinned EditorProjectSource that EditorView uses for the open project. Closing the tool clears
 * the pending artwork so a later Add cannot silently reuse an earlier file.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { extractErrorMessage, MAX_SVG_SOURCE_BYTES, type SceneEditPartSubtype } from '@printstream/shared'
import type { SvgPartRecord } from '@printstream/shared/three-mf'
import type { SvgToolValue } from './SvgToolPanel'
import { svgArtworkParts, type EditorState } from './lib/editorModel'
import { readEditorSvgSource } from './lib/editorSvgSourceRead'
import type { EditorProjectSource } from './lib/editorProjectSource'
import { parseSvgShapes, type ParsedSvg } from './lib/svgGeometry'

interface EditorSvgArtworkOptions {
  active: boolean
  projectSourceRef: { current: EditorProjectSource }
  stateRef: { current: EditorState | null }
  setImporting: Dispatch<SetStateAction<boolean>>
}

/** Keep one panel session over file selection, reopen, commit preparation, and mode exit. */
export function useEditorSvgArtwork({
  active, projectSourceRef, stateRef, setImporting
}: EditorSvgArtworkOptions) {
  const [svgTool, setSvgTool] = useState<SvgToolValue>({
    widthMm: 40, thickness: 2, operation: 'normal_part', includeBackground: false
  })
  const [svgArtwork, setSvgArtwork] = useState<ParsedSvg | null>(null)
  const [svgFileName, setSvgFileName] = useState<string | null>(null)
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const [svgEmptyReason, setSvgEmptyReason] = useState<string | null>(null)
  const [reeditSvgCount, setReeditSvgCount] = useState(0)
  const reeditSvgRef = useRef<{
    entryPath: string
    hostId: number
    fileName: string
    loadedMarkup: string
  } | null>(null)
  const archiveEntriesRef = useRef<readonly string[]>([])
  const svgInputRef = useRef<HTMLInputElement | null>(null)

  /** Open the hidden picker without coupling its DOM ref to the editor shell. */
  const chooseFile = useCallback(() => svgInputRef.current?.click(), [])

  /** Read and validate local artwork before the editor can stage any geometry. */
  const fileChosen = useCallback(async (file: File) => {
    setImporting(true)
    try {
      archiveEntriesRef.current = await projectSourceRef.current.listEntries?.() ?? []
      const markup = await file.text()
      // Markup rides every later save, so refuse a file that cannot fit in the save request here.
      if (markup.length > MAX_SVG_SOURCE_BYTES) {
        setSvgArtwork(null)
        setSvgMarkup(null)
        setSvgFileName(file.name)
        setSvgEmptyReason(
          `That file is ${Math.round(markup.length / 1024)}KB, over the ${Math.round(MAX_SVG_SOURCE_BYTES / 1024)}KB limit. `
          + 'The artwork is stored in the project so it stays editable, so it has to fit in a save. '
          + 'Simplify the drawing or flatten it in your vector editor first.'
        )
        return
      }

      const parsed = parseSvgShapes(markup)
      setSvgFileName(file.name)
      // Neither PrintStream nor Studio stores parsed shapes, so retain the original source bytes.
      setSvgMarkup(markup)
      if (parsed.pieces.length === 0) {
        setSvgArtwork(null)
        setSvgEmptyReason('Nothing in this file is painted, so there is no shape to extrude. Paths need a fill or a stroke.')
        return
      }
      setSvgArtwork(parsed)
      setSvgEmptyReason(null)
    } catch (error) {
      setSvgArtwork(null)
      setSvgEmptyReason(extractErrorMessage(error) || 'That file could not be read as SVG.')
    } finally {
      setImporting(false)
    }
  }, [projectSourceRef, setImporting])

  /** Reopen saved or session artwork from its own host, preferring unsaved source bytes. */
  const reopenArtwork = useCallback(async (
    record: SvgPartRecord,
    hostId: number,
    operation: SceneEditPartSubtype
  ) => {
    setImporting(true)
    try {
      archiveEntriesRef.current = await projectSourceRef.current.listEntries?.() ?? []
      const markup = await readEditorSvgSource(
        record.entryPath,
        stateRef.current,
        (entryPath) => projectSourceRef.current.loadEntry(entryPath)
      )
      const parsed = parseSvgShapes(markup)
      if (parsed.pieces.length === 0) throw new Error('The stored artwork has nothing paintable in it.')
      setSvgArtwork(parsed)
      setSvgMarkup(markup)
      setSvgFileName(record.fileName || record.entryPath)
      setSvgEmptyReason(null)
      setSvgTool((current) => ({
        ...current,
        widthMm: record.widthMm > 0 ? record.widthMm : current.widthMm,
        thickness: record.thickness > 0 ? record.thickness : current.thickness,
        includeBackground: record.includeBackground,
        operation
      }))
      // Reusing identical markup keeps the saved entry instead of minting a duplicate on edit.
      reeditSvgRef.current = { entryPath: record.entryPath, hostId, fileName: record.fileName, loadedMarkup: markup }
      setReeditSvgCount(svgArtworkParts(stateRef.current, hostId, record.entryPath).length)
    } catch (error) {
      // A part whose named source cannot be read is a project inconsistency as well as a panel error.
      console.warn('[editor] could not read stored SVG artwork', record.entryPath, extractErrorMessage(error))
      reeditSvgRef.current = null
      setReeditSvgCount(0)
      setSvgArtwork(null)
      setSvgMarkup(null)
      setSvgFileName(record.fileName || null)
      setSvgEmptyReason(
        `${extractErrorMessage(error) || 'The stored artwork could not be read.'} Choose the file again to re-extrude it.`
      )
    } finally {
      setImporting(false)
    }
  }, [projectSourceRef, setImporting, stateRef])

  /** A fresh SVG import must not retain an older part's entry or replacement count. */
  const clearReedit = useCallback(() => {
    reeditSvgRef.current = null
    setReeditSvgCount(0)
  }, [])

  useEffect(() => {
    if (active || (svgArtwork == null && svgFileName == null && svgEmptyReason == null)) return
    setSvgArtwork(null)
    setSvgFileName(null)
    setSvgMarkup(null)
    setSvgEmptyReason(null)
    clearReedit()
  }, [active, clearReedit, svgArtwork, svgEmptyReason, svgFileName])

  return {
    svgTool, setSvgTool, svgArtwork, svgFileName, svgMarkup, svgEmptyReason,
    reeditSvgRef, reeditSvgCount, archiveEntriesRef, svgInputRef,
    chooseFile, fileChosen, reopenArtwork, clearReedit
  }
}
