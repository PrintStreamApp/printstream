/**
 * Browser-session identity for reopening an unchanged slice result without creating another job.
 *
 * The browser retains only the completed job reference. The hidden output remains server-owned so
 * Preview, Save, and Print keep using the ordinary slicing routes, while the server's abandoned-
 * output sweep remains the crash/closed-tab backstop.
 */
import { deepEqual } from '@printstream/shared'
import type { SliceFileSubmitInput } from './libraryViewHelpers'

export type BrowserSliceResultIdentity = {
  sourceFileId: string
  sourceVersionId: string | null
  input: Omit<SliceFileSubmitInput, 'preparedSourceId'>
}

/** Retain every user-visible slice input while excluding the disposable prepared-source proof. */
export function browserSliceResultIdentity(input: {
  file: { id: string }
  versionId?: string | null
  action?: unknown
  keepDialogOpen?: unknown
} & SliceFileSubmitInput): BrowserSliceResultIdentity {
  const {
    file,
    versionId,
    action: _action,
    keepDialogOpen: _keepDialogOpen,
    preparedSourceId: _preparedSourceId,
    ...sliceInput
  } = input
  return {
    sourceFileId: file.id,
    sourceVersionId: versionId ?? null,
    input: sliceInput
  }
}

/** Whether a retained result represents exactly the slice the editor is requesting now. */
export function canReuseBrowserSliceResult(
  previous: BrowserSliceResultIdentity,
  current: BrowserSliceResultIdentity
): boolean {
  return deepEqual(previous, current)
}
