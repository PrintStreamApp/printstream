/**
 * The synthetic file id a host with no server uses for the project it has open in the tab.
 *
 * WHY IT LIVES IN CORE rather than beside the rest of the local-host adapter: core hooks that take a
 * `sourceFileId` have to be able to tell a real library row from this stand-in, and core must never
 * import from a plugin. The public 3MF editor synthesizes a whole `LibraryFile` so the shared
 * slice-settings machinery works unchanged (`plugins/model-studio/lib/localSliceFile.ts`), and this
 * id is that file's identity.
 *
 * THE HAZARD IT EXISTS TO CLOSE: a truthy id reads as "there is a server file to resolve against",
 * so a gate written as `Boolean(sourceFileId)` enables a WORKSPACE fetch on a page with no workspace.
 * Measured on `/3mf-editor`: opening a project fired
 * `POST /api/slicing/profiles/resolve-process` and took a 403 before the anonymous resolver was
 * ready to answer. Ask {@link isLocalSliceFileId} rather than testing truthiness.
 */

/** Synthetic id for the single project a local host has open; stable so query keys don't churn. */
export const LOCAL_SLICE_FILE_ID = 'local-project'

/**
 * Whether `id` is the local stand-in rather than a library row.
 *
 * Null/undefined is NOT local, it is "no file at all", a different fact with the same consequence
 * here but not everywhere, so callers that care keep the distinction.
 */
export function isLocalSliceFileId(id: string | null | undefined): boolean {
  return id === LOCAL_SLICE_FILE_ID
}

/**
 * The id of a real SERVER file, or null when there is none: the question every gate that decides
 * whether to call a workspace route actually means to ask.
 */
export function serverSourceFileId(id: string | null | undefined): string | null {
  return id && !isLocalSliceFileId(id) ? id : null
}
