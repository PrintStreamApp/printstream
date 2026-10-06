/** Announcement footer action: active news discovery, numeric unread count and a read-only dialog. */
import { useState } from 'react'
import { useProductAnnouncementsFeed } from '../hooks/useProductAnnouncementsFeed'
import { useAnnouncementReadState } from '../hooks/useAnnouncementReadState'
import { countUnreadAnnouncements } from '../lib/announcementUnread'
import { buildApiUrlWithContext } from '../lib/apiUrl'
import { getBrowserEnv } from '../lib/browserEnv'
import { HOSTED_ANNOUNCEMENTS_FEED_URL } from '../lib/productAnnouncementsFeed'
import { FooterUnreadButton } from './FooterUnreadButton'
import { ProductAnnouncementsDialog } from './ProductAnnouncementsDialog'

/** Counts only online-fetched or cached articles, never an invented or bundled announcement list. */
export function FooterAnnouncements({ deployment }: { deployment: 'cloud' | 'self-hosted' }) {
  const [open, setOpen] = useState(false)
  const feedUrl = deployment === 'cloud'
    ? buildApiUrlWithContext('/announcements.json', getBrowserEnv().apiBaseUrl, null)
    : HOSTED_ANNOUNCEMENTS_FEED_URL
  const query = useProductAnnouncementsFeed(feedUrl, true)
  const { readSlugs, markRead } = useAnnouncementReadState(feedUrl)
  const unreadCount = query.data ? countUnreadAnnouncements(query.data.catalog.announcements, readSlugs) : 0

  return (
    <>
      <FooterUnreadButton
        unreadCount={unreadCount}
        tooltip={unreadCount > 0 ? `${unreadCount} unread announcements` : 'View announcements'}
        ariaLabel="View announcements"
        onClick={() => setOpen(true)}
      >
        Announcements
      </FooterUnreadButton>
      <ProductAnnouncementsDialog open={open} feedUrl={feedUrl} onClose={() => setOpen(false)} onRead={markRead} />
    </>
  )
}
