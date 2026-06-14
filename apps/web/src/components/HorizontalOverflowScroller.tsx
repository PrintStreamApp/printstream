import { Box } from '@mui/joy'
import type { SxProps } from '@mui/system'
import React from 'react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { resolveHorizontalOverflowState } from '../lib/horizontalOverflow'

type HorizontalOverflowScrollerProps = {
  children: ReactNode
  sx?: SxProps
  scrollerSx?: SxProps
  fadeColor: string
  fadeWidth?: number
  hideScrollbar?: boolean
}

export function HorizontalOverflowScroller({
  children,
  sx,
  scrollerSx,
  fadeColor,
  fadeWidth = 24,
  hideScrollbar = true
}: HorizontalOverflowScrollerProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [{ showStartFade, showEndFade }, setOverflowState] = useState(() => ({
    isOverflowing: false,
    showStartFade: false,
    showEndFade: false
  }))

  useEffect(() => {
    const node = scrollerRef.current
    if (!node) return

    const updateOverflowState = () => {
      setOverflowState(resolveHorizontalOverflowState({
        scrollLeft: node.scrollLeft,
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth
      }))
    }

    const animationFrame = window.requestAnimationFrame(updateOverflowState)
    node.addEventListener('scroll', updateOverflowState, { passive: true })
    window.addEventListener('resize', updateOverflowState, { passive: true })

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateOverflowState)

    resizeObserver?.observe(node)
    if (node.firstElementChild instanceof HTMLElement) {
      resizeObserver?.observe(node.firstElementChild)
    }

    return () => {
      window.cancelAnimationFrame(animationFrame)
      node.removeEventListener('scroll', updateOverflowState)
      window.removeEventListener('resize', updateOverflowState)
      resizeObserver?.disconnect()
    }
  }, [children])

  return (
    <Box sx={{ position: 'relative', minWidth: 0, ...sx }}>
      <Box
        ref={scrollerRef}
        sx={{
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: hideScrollbar ? 'none' : 'auto',
          WebkitOverflowScrolling: 'touch',
          touchAction: 'pan-x pan-y',
          '&::-webkit-scrollbar': hideScrollbar ? {
            display: 'none'
          } : {
            display: 'block',
            height: 10
          },
          '&::-webkit-scrollbar-thumb': hideScrollbar ? undefined : {
            backgroundColor: 'var(--joy-palette-neutral-700)',
            borderRadius: '999px'
          },
          '&::-webkit-scrollbar-track': hideScrollbar ? undefined : {
            backgroundColor: 'var(--joy-palette-background-level1)'
          },
          ...scrollerSx
        }}
      >
        {children}
      </Box>
      <Box
        aria-hidden="true"
        sx={{
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: fadeWidth,
          opacity: showStartFade ? 1 : 0,
          transition: 'opacity 160ms ease',
          background: `linear-gradient(90deg, ${fadeColor} 0%, rgba(0, 0, 0, 0) 100%)`
        }}
      />
      <Box
        aria-hidden="true"
        sx={{
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: 0,
          width: fadeWidth,
          opacity: showEndFade ? 1 : 0,
          transition: 'opacity 160ms ease',
          background: `linear-gradient(270deg, ${fadeColor} 0%, rgba(0, 0, 0, 0) 100%)`
        }}
      />
    </Box>
  )
}