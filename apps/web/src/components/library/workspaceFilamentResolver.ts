/**
 * The workspace's `FilamentConfigResolver`: resolves a filament preset's config through the workspace
 * route, for every surface that needs one.
 *
 * OWNS the workspace half of the resolver pair. Its counterpart is `localFilamentResolver.ts` in the
 * model-studio plugin, which answers the same question with no workspace (built-in presets via the
 * anonymous endpoint, project filaments from the in-tab 3MF).
 *
 * WHY IT IS A MODULE rather than an inline `apiFetch`: two consumers need the SAME resolver and only
 * one of them is a dialog. `FilamentSettingsDialog` used to inline this call as its default branch,
 * so the slice controller had no resolver to hand anyone, which meant the editor's save-time
 * preset resolution (`filamentConfigAuthoring.ts`) silently did nothing in the library editor, and
 * a project saved there kept losing the material physics the save was supposed to restore. The
 * field is optional on `SliceSettingsController`, so nothing type-checked that gap.
 *
 * Counterpart: `POST /api/slicing/profiles/resolve-filament` (apps/api `routes/slicing.ts`).
 */
import { type ResolveFilamentConfigResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import type { FilamentConfigResolver } from './FilamentSettingsDialog'

/**
 * Resolve a filament preset against the workspace catalogue.
 *
 * Rejects on transport/permission failure like any `apiFetch`; callers that must not fail a user
 * action on it (the save-time authoring pass) catch and treat the slot as unresolved.
 *
 * `options.signal` is for the query-driven callers (a query function passes TanStack's signal
 * through). It is a second OPTIONAL parameter rather than part of the request so this stays
 * structurally assignable to {@link FilamentConfigResolver}: the seam a host may replace, which
 * knows nothing about cancellation. Mirrors `components/workspaceProcessResolver.ts`.
 */
export function resolveWorkspaceFilamentConfig(
  { filamentProfileId, targetId, sourceFileId, projectFilamentId }: Parameters<FilamentConfigResolver>[0],
  options?: { signal?: AbortSignal }
): Promise<ResolveFilamentConfigResponse> {
  return apiFetch<ResolveFilamentConfigResponse>('/api/slicing/profiles/resolve-filament', {
    method: 'POST',
    body: { filamentProfileId, targetId, sourceFileId, projectFilamentId },
    ...(options?.signal ? { signal: options.signal } : {})
  })
}
