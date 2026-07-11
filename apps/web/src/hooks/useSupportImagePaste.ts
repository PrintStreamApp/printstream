/**
 * Paste-to-attach for support composers: pasting an image into the message
 * textarea uploads it as a normal attachment draft AND drops an inline
 * markdown placeholder at the cursor — `![name](uploading:<key>)` while the
 * upload runs, rewritten to `![name](attachment:<id>)` when it lands (or
 * removed if the upload fails or the chip is deleted before it finishes).
 *
 * `attachment:<id>` is a viewer-neutral URI: the message body is shared by
 * both conversation sides, whose download routes differ, so the body can
 * never carry a concrete URL. The support message renderer resolves the URI
 * against the viewer's own base (see `ConversationDialog`); the email
 * renderer leaves it as the image's label text (the attachments line already
 * names the file).
 */
import { useCallback, useEffect, useRef } from 'react'
import type { ClipboardEvent, Dispatch, SetStateAction } from 'react'
import type { SupportAttachmentDraftsState } from './useSupportAttachmentDrafts'

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/**
 * Filename for a pasted image. Browsers name clipboard screenshots
 * generically (`image.png`); give those a distinct `pasted-image-<n>` name so
 * multiple pastes stay tellable-apart in chips and emails.
 */
export function pastedImageFilename(file: Pick<File, 'name' | 'type'>, index: number): string {
  const generic = !file.name || /^image\.[a-z0-9]+$/i.test(file.name)
  if (!generic) return file.name
  const extension = IMAGE_EXTENSIONS[file.type] ?? 'png'
  return `pasted-image-${index}.${extension}`
}

/** Markdown image label: keep it from breaking out of `![label](url)`. */
export function markdownImageLabel(filename: string): string {
  return filename.replace(/[[\]()\\]/g, '_')
}

/** The inline placeholder inserted at paste time, keyed by the draft. */
export function uploadingPlaceholder(filename: string, draftKey: string): string {
  return `![${markdownImageLabel(filename)}](uploading:${draftKey})`
}

/**
 * Returns a `Textarea` onPaste handler wired to the given attachment drafts
 * and message state. Non-image pastes are left to the browser.
 */
export function useSupportImagePaste(
  drafts: SupportAttachmentDraftsState,
  setMessage: Dispatch<SetStateAction<string>>
) {
  // Placeholders whose upload has not settled yet, keyed by draft key.
  const pendingRef = useRef(new Map<string, { token: string; filename: string }>())
  const pasteCountRef = useRef(0)

  // Settle placeholders as their drafts finish: swap in the attachment id on
  // success; remove the placeholder when the upload failed or the draft was
  // removed via its chip before finishing.
  useEffect(() => {
    if (pendingRef.current.size === 0) return
    for (const [key, entry] of [...pendingRef.current]) {
      const draft = drafts.drafts.find((candidate) => candidate.key === key)
      if (draft?.status === 'uploading') continue
      pendingRef.current.delete(key)
      const replacement = draft?.status === 'ready' && draft.attachment
        ? `![${markdownImageLabel(entry.filename)}](attachment:${draft.attachment.id})`
        : ''
      setMessage((current) => current.replace(entry.token, replacement))
    }
  }, [drafts.drafts, setMessage])

  return useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    event.preventDefault()

    const renamed = images.map((file) =>
      new File([file], pastedImageFilename(file, ++pasteCountRef.current), { type: file.type }))
    const added = drafts.addFiles(renamed)
    if (added.length === 0) return

    const tokens: string[] = []
    for (const draft of added) {
      if (draft.status !== 'uploading') continue
      const token = uploadingPlaceholder(draft.file.name, draft.key)
      pendingRef.current.set(draft.key, { token, filename: draft.file.name })
      tokens.push(token)
    }
    if (tokens.length === 0) return

    const cursor = event.currentTarget.selectionStart ?? null
    const insertion = tokens.join('\n')
    setMessage((current) => {
      const at = cursor !== null && cursor <= current.length ? cursor : current.length
      const before = current.slice(0, at)
      const after = current.slice(at)
      return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${insertion}${after && !after.startsWith('\n') ? '\n' : ''}${after}`
    })
  }, [drafts, setMessage])
}
