/**
 * Composer-side state for support-message attachments (cloud-only). Files
 * upload immediately when picked (a resumable chunked upload — see
 * `chunkedSupportAttachmentUpload.ts` and the API's upload-then-claim
 * lifecycle); the send then references the uploaded ids via `attachmentIds`.
 * A removed or abandoned upload is simply never claimed and the server sweeps
 * it. Used by the help dialog and both support conversation composers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE,
  SUPPORT_ATTACHMENTS_MAX_TOTAL_BYTES,
  formatBytes,
  type SupportAttachment
} from '@printstream/shared'
import { isSupportUploadAbortError, uploadSupportAttachmentInChunks } from '../lib/chunkedSupportAttachmentUpload'

export interface SupportAttachmentDraft {
  /** Local identity for list rendering/removal (uploads have no id yet). */
  key: string
  file: File
  status: 'uploading' | 'ready' | 'error'
  /** Fraction uploaded (0..1) while `status` is `uploading`. */
  progress: number
  /** Present once `status` is `ready`. */
  attachment?: SupportAttachment
  /** Present once `status` is `error`. */
  error?: string
}

/** Bytes a draft contributes to the per-message total, whether uploaded yet or not. */
function draftBytes(draft: SupportAttachmentDraft): number {
  return draft.status === 'error' ? 0 : draft.file.size
}

/**
 * Manage the attachments being composed for one support message. `uploadPath`
 * is the surface's attachment base (`/api/support/attachments` or
 * `/api/platform/support/attachments`).
 */
export function useSupportAttachmentDrafts(uploadPath: string) {
  const [drafts, setDrafts] = useState<SupportAttachmentDraft[]>([])
  const nextKeyRef = useRef(0)
  /** In-flight upload per draft, so removal/unmount can cancel the transfer. */
  const uploadsRef = useRef(new Map<string, AbortController>())

  // A picked file can be hundreds of megabytes; an upload left running after
  // the composer closes would burn the user's bandwidth for bytes that can no
  // longer be claimed.
  useEffect(() => {
    const uploads = uploadsRef.current
    return () => {
      for (const controller of uploads.values()) controller.abort()
      uploads.clear()
    }
  }, [])

  /** Accepts files up to the per-message count/size caps; returns the drafts it created. */
  const addFiles = useCallback((files: Iterable<File>): SupportAttachmentDraft[] => {
    // Called from event handlers, so the closure state is current; the cap
    // re-check inside the updater is only a safety net. A draft trimmed by
    // that net leaves its upload unclaimed, which the server sweeps.
    const room = Math.max(0, SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE - drafts.length)
    let runningTotal = drafts.reduce((sum, draft) => sum + draftBytes(draft), 0)

    const newDrafts: SupportAttachmentDraft[] = [...files].slice(0, room).map((file) => {
      const base = { key: `draft-${nextKeyRef.current++}`, file, progress: 0 }
      if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
        return { ...base, status: 'error' as const, error: `Larger than the ${formatBytes(SUPPORT_ATTACHMENT_MAX_BYTES)} limit.` }
      }
      // Mirrors the server's claim-time total check so the user finds out now
      // rather than when the send is rejected.
      if (runningTotal + file.size > SUPPORT_ATTACHMENTS_MAX_TOTAL_BYTES) {
        return {
          ...base,
          status: 'error' as const,
          error: `Over the ${formatBytes(SUPPORT_ATTACHMENTS_MAX_TOTAL_BYTES)} total for one message.`
        }
      }
      runningTotal += file.size
      return { ...base, status: 'uploading' as const }
    })

    if (newDrafts.length === 0) return []
    setDrafts((current) => [...current, ...newDrafts].slice(0, SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE))

    for (const draft of newDrafts) {
      if (draft.status !== 'uploading') continue
      const controller = new AbortController()
      uploadsRef.current.set(draft.key, controller)
      void uploadSupportAttachmentInChunks(uploadPath, draft.file, {
        signal: controller.signal,
        onProgress: (fraction) => {
          setDrafts((current) => current.map((entry) =>
            entry.key === draft.key && entry.status === 'uploading' ? { ...entry, progress: fraction } : entry))
        }
      })
        .then((attachment) => {
          setDrafts((current) => current.map((entry) =>
            entry.key === draft.key ? { ...entry, status: 'ready' as const, progress: 1, attachment } : entry))
        })
        .catch((error: unknown) => {
          // An aborted upload was removed or unmounted; its draft is gone (or
          // going), so there is no error to report.
          if (isSupportUploadAbortError(error)) return
          setDrafts((current) => current.map((entry) =>
            entry.key === draft.key ? { ...entry, status: 'error' as const, error: (error as Error).message } : entry))
        })
        .finally(() => {
          uploadsRef.current.delete(draft.key)
        })
    }
    return newDrafts
  }, [drafts, uploadPath])

  const remove = useCallback((key: string) => {
    // Cancel first: an in-flight upload would otherwise keep transferring bytes
    // that can no longer be claimed. An already-uploaded file is simply never
    // claimed; the server sweeps it.
    uploadsRef.current.get(key)?.abort()
    uploadsRef.current.delete(key)
    setDrafts((current) => current.filter((draft) => draft.key !== key))
  }, [])

  const reset = useCallback(() => {
    for (const controller of uploadsRef.current.values()) controller.abort()
    uploadsRef.current.clear()
    setDrafts([])
  }, [])

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
