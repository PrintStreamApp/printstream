import { MenuItem } from '@mui/joy'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import { extractErrorMessage, type LibraryDownloadLinkResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'

/** Library files Bambu Studio can import directly from a download URL. */
const IMPORTABLE_MODEL_PATTERN = /\.(3mf|stl|step|stp)$/i

/**
 * Slot component for `library.fileActions`. Adds an "Open in Bambu Studio" item
 * to the file kebab menu for importable models (3MF/STL/STEP), mirroring
 * MakerWorld's button. Bambu Studio registers the `bambustudio://open?file=…`
 * URL protocol and fetches the file itself with no browser session, so we first
 * mint a short-lived, unauthenticated download link, then hand the desktop app
 * the deep link. Requires download permission (passed in as `canDownload`).
 */
export function LibraryOpenInBambuStudioAction(props: Record<string, unknown>) {
  const fileId = typeof props.fileId === 'string' ? props.fileId : null
  const name = typeof props.name === 'string' ? props.name : null
  const canDownload = props.canDownload === true
  const onAction = typeof props.onAction === 'function' ? props.onAction as (() => void) : undefined

  if (!fileId || !name || !canDownload || !IMPORTABLE_MODEL_PATTERN.test(name)) return null

  const openInBambuStudio = async () => {
    onAction?.()
    const toastId = toast.loading('Opening in Bambu Studio…')
    try {
      const { url } = await apiFetch<LibraryDownloadLinkResponse>(`/api/library/${fileId}/download-link`, {
        method: 'POST'
      })
      window.location.href = `bambustudio://open?file=${encodeURIComponent(url)}`
      toast.update(toastId, {
        message: 'Opening in Bambu Studio…',
        tone: 'success',
        loading: false,
        durationMs: 6000
      })
    } catch (error) {
      toast.update(toastId, {
        message: extractErrorMessage(error, 'Could not open in Bambu Studio'),
        tone: 'danger',
        loading: false,
        durationMs: 6000
      })
    }
  }

  return (
    <MenuItem onClick={() => { void openInBambuStudio() }}>
      <OpenInNewRounded /> Open in Bambu Studio
    </MenuItem>
  )
}
