/**
 * Read-only online announcements opened beside the app version footer.
 * Mirrors the changelog dialog chrome, but reads the public feed and labels cached news on failure.
 */
import { useEffect } from 'react'
import { Alert, Button, DialogActions, DialogTitle, Divider, Link, ModalClose, Stack, Typography } from '@mui/joy'
import type { ProductAnnouncement } from '@printstream/shared'
import { BackAwareModal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { ListSkeleton } from './ListSkeleton'
import { ProductAnnouncementContent } from './ProductAnnouncementContent'
import { formatDateOnly } from '../lib/dateOnly'
import { announcementArticleUrl } from '../lib/productAnnouncementsFeed'
import { useProductAnnouncementsFeed } from '../hooks/useProductAnnouncementsFeed'

/** Fetches on each opening; only a successful fetch can populate the persistent fallback. */
export function ProductAnnouncementsDialog({ feedUrl, onClose, onRead, open = true }: {
  feedUrl: string
  onClose: () => void
  onRead?: (announcements: readonly ProductAnnouncement[]) => void
  open?: boolean
}) {
  const query = useProductAnnouncementsFeed(feedUrl, false, open)

  // Only rendered data is marked read: a failed/unfinished fetch cannot clear unseen news.
  useEffect(() => {
    if (open && query.data) onRead?.(query.data.catalog.announcements)
  }, [onRead, open, query.data])

  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 600 }}>
        <ModalClose />
        <DialogTitle>Announcements</DialogTitle>
        <ScrollableDialogBody>
          <Stack spacing={2}>
            {query.isError && (
              <Alert color="neutral" variant="soft">
                <Stack spacing={1}>
                  <Typography level="body-sm">
                    {query.data
                      ? 'Unable to refresh announcements. Showing the last saved copy.'
                      : 'Announcements need an internet connection. We could not load the feed.'}
                  </Typography>
                  <Button size="sm" variant="outlined" color="neutral" onClick={() => void query.refetch()} sx={{ alignSelf: 'flex-start' }}>
                    Retry
                  </Button>
                </Stack>
              </Alert>
            )}
            {query.isPending && <ListSkeleton rows={2} />}
            {query.isFetching && query.data && <Typography level="body-xs" textColor="text.tertiary">Checking for new announcements...</Typography>}
            {query.data && (
              <Stack spacing={2.5} divider={<Divider />}>
                {query.data.catalog.announcements.map((announcement) => (
                  <Stack key={announcement.slug} component="article" spacing={1.5}>
                    <Stack spacing={0.5}>
                      <Typography level="title-md" component="h2">{announcement.title}</Typography>
                      <Typography component="time" dateTime={announcement.publishedOn} level="body-xs" textColor="text.tertiary">
                        {formatDateOnly(announcement.publishedOn)}
                      </Typography>
                    </Stack>
                    <ProductAnnouncementContent announcement={announcement} presentation="dialog" />
                    <Link href={announcementArticleUrl(feedUrl, announcement.slug, window.location.href)} target="_blank" rel="noopener noreferrer" level="body-sm" sx={{ alignSelf: 'flex-start' }}>
                      Open article
                    </Link>
                  </Stack>
                ))}
              </Stack>
            )}
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button autoFocus variant="plain" color="neutral" onClick={onClose}>Close</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
