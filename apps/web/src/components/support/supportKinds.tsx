/**
 * Display metadata for support-conversation kinds: label, chip color, icon.
 * Shared by self-hosted support, account Messages, the platform inbox, and the thread
 * dialog so a conversation reads the same on every surface.
 */
import type { ReactNode } from 'react'
import type { ColorPaletteProp } from '@mui/joy'
import BugReportRoundedIcon from '@mui/icons-material/BugReportRounded'
import ForumRoundedIcon from '@mui/icons-material/ForumRounded'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import MailOutlineRoundedIcon from '@mui/icons-material/MailOutlineRounded'
import type { SupportConversationKind } from '@printstream/shared'

export const SUPPORT_KIND_META: Record<SupportConversationKind, { label: string; color: ColorPaletteProp; icon: ReactNode }> = {
  feedback: { label: 'Feedback', color: 'primary', icon: <ForumRoundedIcon /> },
  bug: { label: 'Bug report', color: 'danger', icon: <BugReportRoundedIcon /> },
  question: { label: 'Question', color: 'neutral', icon: <HelpOutlineRoundedIcon /> },
  message: { label: 'Message', color: 'neutral', icon: <MailOutlineRoundedIcon /> }
}

export function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

export function formatConversationTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString()
}
