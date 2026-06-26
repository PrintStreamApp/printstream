import { Box, Button, Stack, Typography } from '@mui/joy'
import React, { useRef, type ReactNode } from 'react'
import { sectionScrollMarginTop } from './dashboard/SectionNav.constants'
import { smoothScrollToElement } from '../lib/smoothScroll'

/**
 * Shared pagination footer with the count summary on the left and page
 * navigation on the right.
 */
export function PaginationFooter({
  showingLabel,
  previousDisabled,
  nextDisabled,
  onPrevious,
  onNext
}: {
  showingLabel: string
  previousDisabled: boolean
  nextDisabled: boolean
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: 1,
        alignItems: 'center'
      }}
    >
      <Typography level="body-sm" textColor="text.tertiary" sx={{ minWidth: 0, flex: 1 }}>
        {showingLabel}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
        <Button size="sm" variant="plain" disabled={previousDisabled} onClick={onPrevious}>Previous</Button>
        <Button size="sm" variant="plain" disabled={nextDisabled} onClick={onNext}>Next</Button>
      </Stack>
    </Box>
  )
}

export function PaginatedSection({
  showingLabel,
  previousDisabled,
  nextDisabled,
  onPrevious,
  onNext,
  children,
  spacing = 1
}: {
  showingLabel: string
  previousDisabled: boolean
  nextDisabled: boolean
  onPrevious: () => void
  onNext: () => void
  children: ReactNode
  spacing?: number
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null)

  const scrollToAnchor = () => {
    if (typeof window === 'undefined') return

    window.requestAnimationFrame(() => {
      if (anchorRef.current) smoothScrollToElement(anchorRef.current)
    })
  }

  const handlePrevious = () => {
    onPrevious()
    scrollToAnchor()
  }

  const handleNext = () => {
    onNext()
    scrollToAnchor()
  }

  return (
    <Stack spacing={spacing}>
      <Box ref={anchorRef} sx={{ scrollMarginTop: sectionScrollMarginTop }}>
        <PaginationFooter
          showingLabel={showingLabel}
          previousDisabled={previousDisabled}
          nextDisabled={nextDisabled}
          onPrevious={handlePrevious}
          onNext={handleNext}
        />
      </Box>
      {children}
      <PaginationFooter
        showingLabel={showingLabel}
        previousDisabled={previousDisabled}
        nextDisabled={nextDisabled}
        onPrevious={handlePrevious}
        onNext={handleNext}
      />
    </Stack>
  )
}