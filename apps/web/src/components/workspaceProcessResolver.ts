/**
 * The workspace's `ProcessConfigResolver`: resolves a process preset's config through the workspace
 * route, for every surface that needs one.
 *
 * OWNS the workspace half of the resolver pair, exactly as `library/workspaceFilamentResolver.ts`
 * does for materials. Its counterpart is `localProcessResolver.ts` in the model-studio plugin, which
 * answers the same question with no workspace (built-in presets via the anonymous endpoint, project
 * presets from the in-tab 3MF).
 *
 * WHY IT IS A MODULE rather than three inline `apiFetch` calls: the request was being written out by
 * hand at three call sites, and one of them (`ProcessSettingsDialog`) also hand-mirrored the RESPONSE
 * as a local structural type. That mirror is the failure the root the development notes names, a field the
 * shared contract grows is silently dropped at a boundary that re-declares it, and it had already
 * started: `baselineOrigin` had to be added to the copy by hand before the dialog could see it.
 *
 * Counterpart: `POST /api/slicing/profiles/resolve-process` (apps/api `routes/slicing.ts`), which
 * types its own response body as `ResolveProcessConfigResponse`, so both ends now name one type.
 */
import { type ResolveProcessConfigResponse } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import type { ProcessConfigResolver } from './ProcessSettingsDialog'

/**
 * Resolve a process preset against the workspace catalogue.
 *
 * `options.signal` is for the query-driven callers (per the web conventions, a query function passes
 * TanStack's signal through). It is a second OPTIONAL parameter rather than part of the request so
 * this stays structurally assignable to {@link ProcessConfigResolver}: the seam the dialog takes,
 * which knows nothing about cancellation. `ProcessSettingsDialog` exercises that assignability by
 * calling `(resolveConfig ?? resolveWorkspaceProcessConfig)(…)`, so a drift is a compile error.
 */
export function resolveWorkspaceProcessConfig(
  { processProfileId, targetId, sourceFileId }: Parameters<ProcessConfigResolver>[0],
  options?: { signal?: AbortSignal }
): Promise<ResolveProcessConfigResponse> {
  return apiFetch<ResolveProcessConfigResponse>('/api/slicing/profiles/resolve-process', {
    method: 'POST',
    body: { processProfileId, targetId, sourceFileId },
    ...(options?.signal ? { signal: options.signal } : {})
  })
}
