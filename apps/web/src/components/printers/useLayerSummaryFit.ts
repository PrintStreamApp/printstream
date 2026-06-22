/**
 * Decides whether the centered "layer X/Y" summary fits between the remaining-time and ETA labels
 * on a printer card's progress row, hiding it when the three would overlap. It measures the row and
 * the summary text (and is told the remaining/ETA widths via the returned setters), then derives the
 * fit. Only shown on narrower grids (cardsPerRow < 4) for jobs that report layer progress.
 * Extracted from PrinterCard so the measurement plumbing lives apart from the card's render logic.
 */
import { useEffect, useRef, useState } from 'react'
import type { PrinterStatus } from '@printstream/shared'

export interface LayerSummaryFit {
  /** Attach to the row that bounds the remaining/summary/ETA group. */
  layerSummaryRowRef: React.MutableRefObject<HTMLDivElement | null>
  /** Attach to the centered summary text node. */
  layerSummaryTextRef: React.MutableRefObject<HTMLElement | null>
  /** Report the measured width of the remaining-time label. */
  setRemainingSummaryWidth: (width: number) => void
  /** Report the measured width of the ETA label. */
  setEtaSummaryWidth: (width: number) => void
  /** True when the summary is shown and fits — render the centered summary. */
  showCenteredLayerSummary: boolean
  /** True when the summary is wanted but the measured widths don't fit. */
  hideLayerSummaryForWidth: boolean
}

export function useLayerSummaryFit(cardsPerRow: number, status: PrinterStatus | undefined): LayerSummaryFit {
  const layerSummaryRowRef = useRef<HTMLDivElement | null>(null)
  const layerSummaryTextRef = useRef<HTMLElement | null>(null)
  const [layerSummaryRowWidth, setLayerSummaryRowWidth] = useState(0)
  const [remainingSummaryWidth, setRemainingSummaryWidth] = useState(0)
  const [etaSummaryWidth, setEtaSummaryWidth] = useState(0)
  const [layerSummaryWidth, setLayerSummaryWidth] = useState(0)

  const showLayerSummary = Boolean(
    cardsPerRow < 4
    && status?.remainingMinutes != null
    && status.currentLayer != null
    && status.totalLayers != null
    && status.totalLayers > 0
  )
  const hideLayerSummaryForWidth = showLayerSummary
    && layerSummaryRowWidth > 0
    && remainingSummaryWidth > 0
    && etaSummaryWidth > 0
    && (remainingSummaryWidth + etaSummaryWidth + (layerSummaryWidth || 64) + 16) - layerSummaryRowWidth > 1
  const showCenteredLayerSummary = showLayerSummary && !hideLayerSummaryForWidth

  useEffect(() => {
    const node = layerSummaryRowRef.current
    if (!node) return undefined

    const updateWidth = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width)
      setLayerSummaryRowWidth((current) => (current === nextWidth ? current : nextWidth))
    }

    updateWidth()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => {
        window.removeEventListener('resize', updateWidth)
      }
    }

    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [showLayerSummary])

  useEffect(() => {
    const node = layerSummaryTextRef.current
    if (!node) return undefined

    const updateWidth = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width)
      setLayerSummaryWidth((current) => (current === nextWidth ? current : nextWidth))
    }

    updateWidth()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => {
        window.removeEventListener('resize', updateWidth)
      }
    }

    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [showCenteredLayerSummary, status?.currentLayer, status?.totalLayers])

  return {
    layerSummaryRowRef,
    layerSummaryTextRef,
    setRemainingSummaryWidth: (width: number) => setRemainingSummaryWidth((current) => (current === width ? current : width)),
    setEtaSummaryWidth: (width: number) => setEtaSummaryWidth((current) => (current === width ? current : width)),
    showCenteredLayerSummary,
    hideLayerSummaryForWidth
  }
}
