/**
 * Composer-side state for support-message attachments (cloud-only). Files
 * upload immediately when picked (`POST <uploadPath>` with a raw
 * `application/octet-stream` body — see the API's upload-then-claim
 * lifecycle); the send then references the uploaded ids via `attachmentIds`.
 * A removed or abandoned upload is simply never claimed and the server sweeps
 * it. Used by the help dialog and both support conversation composers.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE,
  extractErrorMessage,
  formatBytes,
  supportAttachmentUploadResponseSchema,
  type SupportAttachment
} from '@printstream/shared'
import { buildApiUrl } from '../lib/apiUrl'
import { readWorkspaceContextHeader } from '../lib/workspaceContext'

export interface SupportAttachmentDraft {
  /** Local identity for list rendering/removal (uploads have no id yet). */
  key: string
  file: File
  status: 'uploading' | 'ready' | 'error'
  /** Present once `status` is `ready`. */
  attachment?: SupportAttachment
  /** Present once `status` is `error`. */
  error?: string
}

async function uploadSupportAttachment(uploadPath: string, file: File): Promise<SupportAttachment> {
  const params = new URLSearchParams({
    filename: file.name,
    contentType: file.type || 'application/octet-stream'
  })
  const workspaceContext = readWorkspaceContextHeader()
  const response = await fetch(buildApiUrl(`${uploadPath}?${params}`), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(workspaceContext ? { 'X-PrintStream-Tenant': workspaceContext } : {})
    },
    body: file
  })
  if (!response.ok) {
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    throw new Error(extractErrorMessage(payload, `Upload failed (${response.status})`))
  }
  return supportAttachmentUploadResponseSchema.parse(await response.json()).attachment
}

/**
 * Manage the attachments being composed for one support message. `uploadPath`
 * is the surface's upload endpoint (`/api/support/attachments` or
 * `/api/platform/support/attachments`).
 */
export function useSupportAttachmentDrafts(uploadPath: string) {
  const [drafts, setDrafts] = useState<SupportAttachmentDraft[]>([])
  const nextKeyRef = useRef(0)

  const addFiles = useCallback((files: Iterable<File>) => {
    // Called from event handlers, so the closure state is current; the cap
    // re-check inside the updater is only a safety net. A draft trimmed by
    // that net leaves its upload unclaimed, which the server sweeps.
    const room = Math.max(0, SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE - drafts.length)
    const newDrafts: SupportAttachmentDraft[] = [...files].slice(0, room).map((file) => ({
      key: `draft-${nextKeyRef.current++}`,
      file,
      ...(file.size > SUPPORT_ATTACHMENT_MAX_BYTES
        ? { status: 'error' as const, error: `Larger than the ${formatBytes(SUPPORT_ATTACHMENT_MAX_BYTES)} limit.` }
        : { status: 'uploading' as const })
    }))
    if (newDrafts.length === 0) return
    setDrafts((current) => [...current, ...newDrafts].slice(0, SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE))
    for (const draft of newDrafts) {
      if (draft.status !== 'uploading') continue
      void uploadSupportAttachment(uploadPath, draft.file)
        .then((attachment) => {
          setDrafts((current) => current.map((entry) =>
            entry.key === draft.key ? { ...entry, status: 'ready' as const, attachment } : entry))
        })
        .catch((error: unknown) => {
          setDrafts((current) => current.map((entry) =>
            entry.key === draft.key ? { ...entry, status: 'error' as const, error: (error as Error).message } : entry))
        })
    }
  }, [drafts.length, uploadPath])

  const remove = useCallback((key: string) => {
    // An already-uploaded file is simply never claimed; the server sweeps it.
    setDrafts((current) => current.filter((draft) => draft.key !== key))
  }, [])

  const reset = useCallback(() => setDrafts([]), [])

  return useMemo(() => ({
    drafts,
    addFiles,
    remove,
    reset,
    /** Ids to send as the message's `attachmentIds`. */
    attachmentIds: drafts
      .filter((draft) => draft.status === 'ready')
      .map((draft) => draft.attachment!.id),
    /** True while any pick is still uploading — hold the send. */
    uploading: drafts.some((draft) => draft.status === 'uploading'),
    atCapacity: drafts.length >= SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE
  }), [drafts, addFiles, remove, reset])
}

export type SupportAttachmentDraftsState = ReturnType<typeof useSupportAttachmentDrafts>
