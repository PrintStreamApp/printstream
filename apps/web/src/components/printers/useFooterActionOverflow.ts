/**
 * Measures the printer-card footer action row and decides which actions render inline versus
 * collapse into an overflow menu. It keeps a hidden off-screen copy of every action (plus the
 * overflow button) to learn each one's natural width, observes the live row for resizes, and
 * recomputes the inline/overflow split so the footer never wraps. Extracted from PrinterCard so
 * the measurement plumbing lives apart from the card's render logic.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { areNumberMapsEqual } from '../../lib/printersViewHelpers'
import { resolvePrinterCardFooterOverflowKeys, type PrinterCardFooterActionDescriptor } from '../../lib/printerCardFooterActions'

export interface PrinterCardFooterAction extends PrinterCardFooterActionDescriptor {
  fill?: boolean
  inline: ReactElement
  overflow: ReactElement
}

const FOOTER_ACTION_GAP_PX = 8
const DEFAULT_OVERFLOW_MENU_BUTTON_WIDTH = 36

export interface FooterActionOverflow {
  /** Attach to the live, visible action row (the element whose width gates overflow). */
  footerActionRowRef: React.MutableRefObject<HTMLDivElement | null>
  /** Attach to the hidden off-screen container that holds the measurement copies. */
  footerActionMeasureRootRef: React.MutableRefObject<HTMLDivElement | null>
  /** Attach to the hidden overflow-menu button copy so its width can be reserved. */
  footerOverflowMenuMeasureRef: React.MutableRefObject<HTMLButtonElement | null>
  /** Per-action measurement nodes, keyed by action key. */
  footerActionMeasureRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  /** Actions that fit inline, in order. */
  visibleFooterActions: PrinterCardFooterAction[]
  /** Actions pushed into the overflow menu, in order. */
  overflowFooterActions: PrinterCardFooterAction[]
  /** Actions that count toward "are there any footer controls" (optional ones must have width). */
  measurableFooterActions: PrinterCardFooterAction[]
}

export function useFooterActionOverflow(
  footerActions: PrinterCardFooterAction[],
  footerControlsEnabled: boolean
): FooterActionOverflow {
  const footerActionRowRef = useRef<HTMLDivElement | null>(null)
  const footerActionMeasureRootRef = useRef<HTMLDivElement | null>(null)
  const footerOverflowMenuMeasureRef = useRef<HTMLButtonElement | null>(null)
  const footerActionMeasureRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const [footerActionRowWidth, setFooterActionRowWidth] = useState<number | null>(null)
  const [footerActionWidths, setFooterActionWidths] = useState<Record<string, number>>({})
  const [footerOverflowMenuButtonWidth, setFooterOverflowMenuButtonWidth] = useState<number | null>(null)

  const reservedOverflowMenuButtonWidth = footerOverflowMenuButtonWidth ?? DEFAULT_OVERFLOW_MENU_BUTTON_WIDTH
  const footerOverflowKeys = resolvePrinterCardFooterOverflowKeys({
    actions: footerActions,
    actionWidths: footerActionWidths,
    rowWidth: footerActionRowWidth,
    overflowButtonWidth: reservedOverflowMenuButtonWidth,
    gapPx: FOOTER_ACTION_GAP_PX
  })
  const measurableFooterActions = footerActions.filter((action) => !action.optional || (footerActionWidths[action.key] ?? 0) > 0)
  const visibleFooterActions = footerActions.filter((action) => !footerOverflowKeys.has(action.key))
  const overflowFooterActions = footerActions.filter((action) => footerOverflowKeys.has(action.key))

  const measureFooterActions = useCallback(() => {
    const row = footerActionRowRef.current
    const nextRowWidth = row ? Math.round(row.getBoundingClientRect().width) : null
    setFooterActionRowWidth((current) => (current === nextRowWidth ? current : nextRowWidth))

    const nextActionWidths = Object.fromEntries(footerActions.map((action) => {
      const node = footerActionMeasureRefs.current[action.key]
      return [action.key, node ? Math.round(node.getBoundingClientRect().width) : 0]
    }))
    setFooterActionWidths((current) => areNumberMapsEqual(current, nextActionWidths) ? current : nextActionWidths)

    const overflowMenuButton = footerOverflowMenuMeasureRef.current
    const nextOverflowButtonWidth = overflowMenuButton ? Math.round(overflowMenuButton.getBoundingClientRect().width) : null
    setFooterOverflowMenuButtonWidth((current) => (current === nextOverflowButtonWidth ? current : nextOverflowButtonWidth))
  }, [footerActions])

  useLayoutEffect(() => {
    if (!footerControlsEnabled) return undefined

    measureFooterActions()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureFooterActions)
      return () => {
        window.removeEventListener('resize', measureFooterActions)
      }
    }

    let frameId: number | null = null
    const scheduleMeasurement = () => {
      if (frameId != null) window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        measureFooterActions()
      })
    }

    const observer = new ResizeObserver(scheduleMeasurement)
    const row = footerActionRowRef.current
    const measureRoot = footerActionMeasureRootRef.current
    const overflowMenuButton = footerOverflowMenuMeasureRef.current

    if (row) observer.observe(row)
    if (measureRoot) {
      observer.observe(measureRoot)
      for (const child of Array.from(measureRoot.children)) {
        observer.observe(child)
      }
    }
    if (overflowMenuButton) observer.observe(overflowMenuButton)

    return () => {
      if (frameId != null) window.cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [footerControlsEnabled, footerActions, measureFooterActions])

  return {
    footerActionRowRef,
    footerActionMeasureRootRef,
    footerOverflowMenuMeasureRef,
    footerActionMeasureRefs,
    visibleFooterActions,
    overflowFooterActions,
    measurableFooterActions
  }
}
