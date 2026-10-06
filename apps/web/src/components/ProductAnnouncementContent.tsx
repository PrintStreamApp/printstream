/** Plain-text announcement blocks shared by article pages, list entries and the app dialog. */
import { Box, Stack, Typography } from '@mui/joy'
import type { ProductAnnouncement } from '@printstream/shared'

/** Renders validated content; promotion changes presentation without changing the editorial copy. */
export function ProductAnnouncementContent({
  announcement,
  presentation = 'article'
}: {
  announcement: ProductAnnouncement
  presentation?: 'article' | 'promotion' | 'dialog'
}) {
  const bodyLevel = presentation === 'dialog' ? 'body-sm' : 'body-md'

  return (
    <Stack spacing={2}>
      {announcement.blocks.map((block, index) => {
        if (block.type === 'paragraph') {
          return <Typography key={index} level={bodyLevel}>{block.text}</Typography>
        }

        if (presentation === 'promotion') {
          return (
            <Box
              key={index}
              component="ul"
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                gap: 2.5,
                listStyle: 'none',
                p: 0,
                m: 0
              }}
            >
              {block.items.map((item, itemIndex) => (
                <Stack component="li" key={itemIndex} spacing={0.5} sx={{ minWidth: 0 }}>
                  {item.title && <Typography level="title-lg">{item.title}</Typography>}
                  <Typography level="body-md">{item.text}</Typography>
                </Stack>
              ))}
            </Box>
          )
        }

        return (
          <Stack key={index} component="ul" spacing={1} sx={{ m: 0, pl: 2.5 }}>
            {block.items.map((item, itemIndex) => (
              <Typography component="li" key={itemIndex} level={bodyLevel}>
                {item.title && <><strong>{item.title}</strong>: </>}{item.text}
              </Typography>
            ))}
          </Stack>
        )
      })}
    </Stack>
  )
}
