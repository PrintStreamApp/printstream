/**
 * Text that only shows a tooltip when its rendered content is truncated.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Tooltip, Typography, type TypographyProps } from '@mui/joy'

type OverflowTooltipTextMetrics = {
  isTruncated: boolean
  naturalWidth: number
  renderedWidth: number
}

export function OverflowTooltipText({
  text,
  observeRef,
  onMetricsChange,
  ...typographyProps
}: Omit<TypographyProps, 'children'> & {
  text: string
  observeRef?: RefObject<HTMLElement | null>
  onMetricsChange?: (metrics: OverflowTooltipTextMetrics) => void
}) {
  const textRef = useRef<HTMLElement | null>(null)
  const lastMetricsRef = useRef<OverflowTooltipTextMetrics | null>(null)
  const [isTruncated, setIsTruncated] = useState(false)

  useLayoutEffect(() => {
    const node = textRef.current
    if (!node) return

    let frameId = 0
    let active = true

    const measureNaturalWidth = () => {
      const clone = node.cloneNode(true) as HTMLElement
      clone.style.position = 'absolute'
      clone.style.visibility = 'hidden'
      clone.style.pointerEvents = 'none'
      clone.style.overflow = 'visible'
      clone.style.textOverflow = 'clip'
      clone.style.whiteSpace = 'nowrap'
      clone.style.inlineSize = 'max-content'
      clone.style.maxInlineSize = 'none'
      clone.style.minInlineSize = '0'
      clone.style.blockSize = 'auto'
      document.body.appendChild(clone)
      const width = clone.getBoundingClientRect().width
      clone.remove()
      return width
    }

    const updateTruncation = () => {
      if (!active) return
      const widthOverflow = node.scrollWidth - node.clientWidth > 1
      const heightOverflow = node.scrollHeight - node.clientHeight > 1
      const naturalWidth = widthOverflow ? node.scrollWidth : measureNaturalWidth()
      const renderedWidth = node.getBoundingClientRect().width
      const nextValue = widthOverflow || heightOverflow || naturalWidth - renderedWidth > 1
      const nextMetrics = {
        isTruncated: nextValue,
        naturalWidth,
        renderedWidth
      }
      const previousMetrics = lastMetricsRef.current
      if (
        !previousMetrics
        || previousMetrics.isTruncated !== nextMetrics.isTruncated
        || Math.abs(previousMetrics.naturalWidth - nextMetrics.naturalWidth) > 1
        || Math.abs(previousMetrics.renderedWidth - nextMetrics.renderedWidth) > 1
      ) {
        lastMetricsRef.current = nextMetrics
        onMetricsChange?.(nextMetrics)
      }
      setIsTruncated((current) => (current === nextValue ? current : nextValue))
    }

    const scheduleUpdate = () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(() => {
        frameId = 0
        updateTruncation()
      })
    }

    scheduleUpdate()

    void document.fonts?.ready.then(() => {
      if (!active) return
      scheduleUpdate()
    })

    const mutationObserver = new MutationObserver(scheduleUpdate)
    mutationObserver.observe(node, {
      characterData: true,
      childList: true,
      subtree: true
    })

    const boundaryNode = observeRef?.current ?? node.closest('.MuiCard-root')

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', scheduleUpdate)
      return () => {
        active = false
        if (frameId) window.cancelAnimationFrame(frameId)
        mutationObserver.disconnect()
        window.removeEventListener('resize', scheduleUpdate)
      }
    }

    const observer = new ResizeObserver(scheduleUpdate)
    observer.observe(node)
    if (node.parentElement) observer.observe(node.parentElement)
    if (boundaryNode && boundaryNode !== node.parentElement) observer.observe(boundaryNode)

    return () => {
      active = false
      if (frameId) window.cancelAnimationFrame(frameId)
      mutationObserver.disconnect()
      observer.disconnect()
    }
  }, [text, observeRef, onMetricsChange])

  const content = (
    <Typography ref={textRef} {...typographyProps}>
      {text}
    </Typography>
  )

  return (
    <Tooltip
      title={isTruncated ? text : ''}
      placement="top"
      arrow
      disableHoverListener={!isTruncated}
      disableFocusListener={!isTruncated}
      disableTouchListener={!isTruncated}
    >
      {content}
    </Tooltip>
  )
}