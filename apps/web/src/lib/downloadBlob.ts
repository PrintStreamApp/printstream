/**
 * Trigger a browser "save file" download for in-memory bytes (client-generated
 * exports like the editor's object STL export). Server-stored files should keep
 * using plain `<a href download>` links against their download endpoints; this
 * helper is only for content that exists solely in the page.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke after the click has been dispatched: revoking synchronously can abort
  // the download in some browsers, which read the blob URL asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
