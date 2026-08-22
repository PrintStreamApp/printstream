import type { RemoteImportCandidate } from '@printstream/shared'

/**
 * Which file list the import picker shows, and whether it is left over from the extension
 * handoff. The counterpart is `RemoteImportsView`, which renders the list plus a notice when
 * `staleHandoff` is true and nothing could be resolved for the URL in the field.
 *
 * Rule: a pasted URL the server can fetch resolves to its own candidate and supersedes the
 * handoff files at once; a page that needs the browser helper resolves to nothing here, so the
 * handoff files stay listed (still importable) rather than the picker emptying out.
 */
export function selectPickerCandidates(input: {
  /** Files the extension handed over, from the `candidates` query param. */
  handoffCandidates: RemoteImportCandidate[]
  /** The page the extension scraped, empty when this visit is not a handoff. */
  handoffUrl: string
  /** Current Source URL field value. */
  url: string
  /** Candidates `detectRemoteImportUrl` resolves for the field value alone. */
  pastedCandidates: RemoteImportCandidate[]
  /** Candidates for the effective import URL (selected file, else the field value). */
  importCandidates: RemoteImportCandidate[]
}): { candidates: RemoteImportCandidate[]; staleHandoff: boolean } {
  const trimmed = input.url.trim()
  const staleHandoff = input.handoffCandidates.length > 0 && trimmed.length > 0 && trimmed !== input.handoffUrl

  if (staleHandoff && input.pastedCandidates.length > 0) {
    return { candidates: input.pastedCandidates, staleHandoff }
  }
  return {
    candidates: input.handoffCandidates.length > 0 ? input.handoffCandidates : input.importCandidates,
    staleHandoff
  }
}
