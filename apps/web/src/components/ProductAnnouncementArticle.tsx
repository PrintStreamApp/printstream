/** Shared understated article surface for dated product announcements. */
import { Link, Sheet, Stack, Typography } from '@mui/joy'
import { Link as RouterLink } from 'react-router-dom'
import { getProductAnnouncementPath, type ProductAnnouncement } from '@printstream/shared'
import { formatDateOnly } from '../lib/dateOnly'
import { ProductAnnouncementContent } from './ProductAnnouncementContent'

/** The list links each headline to its article; the standalone article has a plain headline. */
export function ProductAnnouncementArticle({ announcement, linkTitle = false }: { announcement: ProductAnnouncement; linkTitle?: boolean }) {
  const titleId = `announcement-${announcement.slug}`

  return (
    <Sheet component="article" variant="outlined" aria-labelledby={titleId} sx={{ borderRadius: 'lg', p: { xs: 2.5, sm: 4 } }}>
      <Stack spacing={2.5}>
        <Stack spacing={1}>
          <Typography id={titleId} level="title-lg" component={linkTitle ? 'h2' : 'h1'}>
            {linkTitle ? (
              <Link component={RouterLink} to={getProductAnnouncementPath(announcement.slug)} color="neutral">
                {announcement.title}
              </Link>
            ) : announcement.title}
          </Typography>
          <Typography component="time" dateTime={announcement.publishedOn} level="body-sm" textColor="neutral.400">
            {formatDateOnly(announcement.publishedOn)}
          </Typography>
        </Stack>
        <ProductAnnouncementContent announcement={announcement} />
      </Stack>
    </Sheet>
  )
}
