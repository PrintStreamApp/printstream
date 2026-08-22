/**
 * Heading for one top-level section of a page navigated by {@link SectionNav} (Jobs today).
 *
 * Owns the rule a bare title cannot: when several stacked sections all render runs of identical
 * outlined cards, nothing marks where one section ends and the next begins, because the gap
 * between sections is barely larger than the gap between cards. Every section therefore gets the
 * same anatomy — its own icon, a `title-lg` title, its item count, one line naming what belongs
 * in it, and a full-width rule closing the header off from the cards beneath.
 *
 * Purely presentational. The section's anchor id and `scrollMarginTop` stay on the caller's
 * wrapper, which is the element `SectionNav` scrolls to.
 *
 * A section that has outgrown the stack and become its own route passes
 * `level="h3"`, which is the heading size every other top-level view uses; it
 * keeps the count, description, and actions rather than growing a second header
 * above them.
 *
 * Counterpart: `SectionNav` renders the same sections as a nav strip, so a section's title and
 * count must agree between the two.
 */
import { Box, Chip, Divider, Stack, Typography } from '@mui/joy'
import { type ReactNode } from 'react'

/**
 * `spacing` for the Stack that holds a page's sections — the gap BETWEEN sections.
 *
 * It has to read as clearly larger than the gaps inside a section (cards at 1, heading blocks at
 * 1.25) or the sections merge into one wall, which is the whole problem {@link PageSectionHeading}
 * exists to solve. Set it on the container rather than as a margin on the heading: Joy's `Stack`
 * spaces children with a `& > * ~ *` margin rule that out-specifies a child's own `mt`.
 */
export const pageSectionStackSpacing = 4

export function PageSectionHeading({
  icon,
  title,
  description,
  count,
  actions,
  level = 'title-lg'
}: {
  /** The section's icon, matching the icon its `EmptyState` uses. */
  icon: ReactNode
  title: string
  /** One short line saying what lands in this section. */
  description?: string
  /** Item count. Hidden at zero (the section's empty state already says so), like `SectionNav`. */
  count?: number | null
  /** Section-level actions, right-aligned beside the title on desktop and wrapping below it when narrow. */
  actions?: ReactNode
  /**
   * Typography level for the title. `h3` when this section IS a page rather
   * than one of several stacked on one — a section that becomes its own route
   * must not keep a heading a size smaller than every other top-level view's.
   */
  level?: 'title-lg' | 'h3'
}) {
  return (
    <Stack spacing={0.75}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="flex-start"
        justifyContent="space-between"
        sx={{ flexWrap: 'wrap', rowGap: 0.75 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            level={level}
            startDecorator={icon}
            endDecorator={count != null && count > 0 ? (
              // `component="span"`, not Chip's default `div`: Typography renders as a
              // `<p>` at every level this takes, and a `<div>` inside a `<p>` is invalid
              // HTML — React logs a validateDOMNesting error, and the browser's parser
              // is entitled to close the paragraph early and reparent the chip. Joy sets
              // the chip's `display` from its own class, so the tag swap is visually inert.
              <Chip component="span" size="sm" variant="soft" color="neutral">{count}</Chip>
            ) : null}
          >
            {title}
          </Typography>
          {description && (
            <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
          )}
        </Box>
        {actions}
      </Stack>
      {/* Joy's default divider tint (16% grey) sits BELOW the outlined cards' own border on every
          theme, so as a section break it reads as one more card edge. `neutral.600` is a step above
          that border, which is what makes the eye take the rule as a boundary. */}
      <Divider sx={{ '--Divider-lineColor': 'var(--joy-palette-neutral-600)' }} />
    </Stack>
  )
}
