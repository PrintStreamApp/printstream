/**
 * Shared renderer for user-authored markdown (support messages, suggestion
 * posts and comments, firmware release notes). Lazy-loads the actual
 * `react-markdown` implementation (`MarkdownContent.tsx`) so the parser never
 * lands in the core bundle; while it loads, the raw text shows as pre-wrapped
 * plain text so content is readable immediately.
 */
import { lazy, Suspense } from 'react'
import { Box } from '@mui/joy'

const MarkdownContent = lazy(() => import('./MarkdownContent'))

export function Markdown({
  children,
  colorInherit = false,
  resolveUri
}: {
  children: string
  /** Inherit the surrounding text colour (e.g. inside a solid chat bubble). */
  colorInherit?: boolean
  /** Resolve app-specific URI schemes (e.g. `attachment:<id>`); see MarkdownContent. */
  resolveUri?: (uri: string) => string | null
}) {
  return (
    <Suspense
      fallback={
        <Box sx={{ fontSize: 'sm', lineHeight: 'md', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {children}
        </Box>
      }
    >
      <MarkdownContent colorInherit={colorInherit} resolveUri={resolveUri}>{children}</MarkdownContent>
    </Suspense>
  )
}
