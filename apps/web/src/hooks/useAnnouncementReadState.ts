/** Same-device read state shared by the footer badge and its announcement dialog. */
import { useCallback } from 'react'
import type { ProductAnnouncement } from '@printstream/shared'
import { useLocalStorageState } from './useLocalStorageState'
import { countUnreadAnnouncements, EMPTY_READ_ANNOUNCEMENTS, mergeReadAnnouncementSlugs, parseReadAnnouncementSlugs } from '../lib/announcementUnread'

/** Marks only fetched articles that the dialog actually renders, preserving markers for older entries. */
export function useAnnouncementReadState(feedUrl: string) {
  const [readSlugs, setReadSlugs] = useLocalStorageState<readonly string[]>(
    `printstream.announcements.readSlugs:${feedUrl}`,
    EMPTY_READ_ANNOUNCEMENTS,
    parseReadAnnouncementSlugs
  )
  const markRead = useCallback((announcements: readonly ProductAnnouncement[]) => {
    if (countUnreadAnnouncements(announcements, readSlugs) === 0) return
    setReadSlugs(mergeReadAnnouncementSlugs(readSlugs, announcements))
  }, [readSlugs, setReadSlugs])

  return { readSlugs, markRead }
}
