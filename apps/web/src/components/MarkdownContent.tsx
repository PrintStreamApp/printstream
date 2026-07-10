/**
 * Implementation behind the shared `Markdown` component — split out so
 * `react-markdown` (and remark-gfm) load lazily and stay off the core bundle.
 * Import `Markdown` from `./Markdown` instead of using this directly.
 *
 * Renders GitHub-flavoured markdown with Joy-friendly typography. Raw HTML in
 * the source is never rendered (react-markdown's default), so user-authored
 * content is safe; links open in a new tab. Headings are clamped to modest
 * sizes because this renders user-generated discussion content, not documents.
 */
import { Box, Link } from '@mui/joy'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function MarkdownContent({
  children,
  colorInherit = false
}: {
  children: string
  /** Inherit the surrounding text colour (e.g. inside a solid chat bubble). */
  colorInherit?: boolean
}) {
  return (
    <Box
      sx={{
        fontSize: 'sm',
        lineHeight: 'md',
        overflowWrap: 'anywhere',
        '& > :first-child': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p': { my: 0.75 },
        '& ul, & ol': { my: 0.75, pl: 3 },
        '& li + li': { mt: 0.375 },
        '& h1, & h2, & h3, & h4, & h5, & h6': { mt: 1.25, mb: 0.5, fontSize: 'md', fontWeight: 'lg' },
        '& code': {
          px: 0.375,
          py: 0.125,
          borderRadius: 'xs',
          fontFamily: 'monospace',
          fontSize: '0.85em',
          backgroundColor: colorInherit ? 'rgba(0, 0, 0, 0.25)' : 'background.level2'
        },
        '& pre': {
          my: 1,
          p: 1,
          borderRadius: 'sm',
          overflow: 'auto',
          backgroundColor: colorInherit ? 'rgba(0, 0, 0, 0.25)' : 'background.level2'
        },
        '& pre code': { p: 0, backgroundColor: 'transparent' },
        '& blockquote': {
          my: 1,
          mx: 0,
          pl: 1.25,
          borderLeft: '3px solid',
          borderColor: colorInherit ? 'currentColor' : 'neutral.outlinedBorder',
          color: colorInherit ? 'inherit' : 'text.secondary',
          opacity: colorInherit ? 0.85 : undefined
        },
        '& hr': { my: 1.25, border: 'none', borderTop: '1px solid', borderColor: colorInherit ? 'currentColor' : 'divider' },
        '& table': { display: 'block', width: 'fit-content', maxWidth: '100%', my: 1, borderCollapse: 'collapse', overflowX: 'auto' },
        '& th, & td': { p: 0.5, border: '1px solid', borderColor: colorInherit ? 'currentColor' : 'divider', textAlign: 'left' },
        '& img': { maxWidth: '100%' },
        ...(colorInherit ? { color: 'inherit', '& a': { color: 'inherit', textDecoration: 'underline' } } : {})
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, children: linkChildren, href, title }) => (
            <Link href={href} title={title} target="_blank" rel="noreferrer">
              {linkChildren}
            </Link>
          )
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  )
}
