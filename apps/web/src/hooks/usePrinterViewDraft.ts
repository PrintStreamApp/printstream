/**
 * Unsaved toolbar edits for a saved printer view.
 *
 * A route change discards the previous view's draft. Overview writes through
 * to local display preferences; saved views hold edits until Save or Reset.
 */
import { useCallback, useEffect, useState } from 'react'
import type { PrinterView } from '@printstream/shared'
import {
  isPrinterViewDraftDirty,
  resolvePrinterViewContent,
  type PrinterViewContent,
  type PrinterViewDraft
} from '../lib/printerViewDraft.js'

type Options = {
  activeView: PrinterView | null
  activeViewId: string | null
  overviewDefaults: PrinterViewContent
  onOverviewChange: (partial: PrinterViewDraft) => void
  onStageChange: () => void
}

/** Return effective toolbar content and draft transitions for the active view. */
export function usePrinterViewDraft({
  activeView,
  activeViewId,
  overviewDefaults,
  onOverviewChange,
  onStageChange
}: Options) {
  const [draft, setDraft] = useState<PrinterViewDraft | null>(null)
  const content = resolvePrinterViewContent(activeView, draft, overviewDefaults)
  const isDirty = isPrinterViewDraftDirty(activeView, content)

  const clear = useCallback(() => setDraft(null), [])

  useEffect(() => {
    clear()
  }, [activeViewId, clear])

  const apply = useCallback((partial: PrinterViewDraft) => {
    onStageChange()
    if (activeView) {
      setDraft((current) => ({ ...current, ...partial }))
      return
    }
    onOverviewChange(partial)
  }, [activeView, onOverviewChange, onStageChange])

  return { content, isDirty, apply, clear }
}
