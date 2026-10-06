/** Shared public-feed query for unread discovery in the footer and reading in its dialog. */
import { useQuery } from '@tanstack/react-query'
import { fetchAnnouncementsFeed, readCachedAnnouncements } from '../lib/productAnnouncementsFeed'

/** Checks on mount; the footer additionally checks hourly while visible, sharing requests with the dialog. */
export function useProductAnnouncementsFeed(feedUrl: string, refreshHourly = false, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['product-announcements', feedUrl],
    queryFn: ({ signal }) => fetchAnnouncementsFeed(feedUrl, signal),
    initialData: () => readCachedAnnouncements(feedUrl),
    staleTime: 0,
    retry: false,
    networkMode: 'always',
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchInterval: refreshHourly ? 60 * 60_000 : false,
    refetchIntervalInBackground: false
  })
}
