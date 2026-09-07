/**
 * The one module that fetches `POST /api/slicing/profiles/resolve-machine`.
 *
 * The sibling of `workspaceProcessResolver.ts` and `library/workspaceFilamentResolver.ts`, and it
 * exists for the reason those do: three callers had each declared their own `ResolveMachineResponse`
 * with the fields they happened to need, and each was a valid supertype of the real one, so the type
 * checker had nothing to say while they drifted apart. The machine settings dialog read `config` and
 * `baseConfig`; the project-overrides hook read `projectOverrides`; neither could see a field the
 * route grew. Root the development notes names this exact failure: rebuilding a shared type field-by-field at
 * a boundary silently drops everything the contract later adds.
 *
 * `workspaceResolvers.test.ts` fails the build on a second module fetching this route.
 *
 * Counterpart: the route in `apps/api/src/routes/slicing.ts`, whose anonymous twin is
 * `/api/public/slicing/resolve-machine` (built-ins only, and it answers the same `config` + `name`).
 */
import { apiFetch } from '../lib/apiClient'
import type { ProfileRecord } from '@printstream/shared'

/** Everything the route answers. Callers destructure what they need rather than narrowing the type. */
export interface ResolveMachineConfigResponse {
  /** The fully resolved machine config, with every `inherits` hop flattened. */
  config: ProfileRecord
  /** The resolved preset's own name, which a retarget persists as `printer_settings_id`. */
  name: string
  /** The parent preset a declared `inherits` resolves to, else the config itself. */
  baseConfig?: ProfileRecord
  overriddenKeys?: string[]
  /**
   * What the SOURCE PROJECT overrides relative to the preset, when `sourceFileId` was given.
   *
   * Null and `{}` mean different things and must not be collapsed: `{}` states the project overrides
   * nothing, which licenses a save to CLEAR the record, while null says we never found out. See the
   * route, where answering `{}` for a briefly-offline bridge erased users' printer overrides.
   */
  projectOverrides?: Record<string, string | string[]> | null
}

export interface ResolveMachineConfigRequest {
  machineProfileId: string
  targetId: string | null
  /** Ask what a specific project overrides, as well as resolving the preset. */
  sourceFileId?: string | null
  /** The version the answer describes, so a cached one cannot outlive the file it read. */
  sourceFileUploadedAt?: string
}

/**
 * Resolve a machine preset against the workspace catalogue, which resolves the workspace's own
 * presets as well as the built-ins.
 *
 * `options.signal` is a second optional parameter rather than part of the request, matching the
 * process resolver: the seams that take this function know nothing about cancellation, and query
 * callers pass TanStack's signal through per the web conventions.
 */
export function resolveWorkspaceMachineConfig(
  request: ResolveMachineConfigRequest,
  options?: { signal?: AbortSignal }
): Promise<ResolveMachineConfigResponse> {
  return apiFetch<ResolveMachineConfigResponse>('/api/slicing/profiles/resolve-machine', {
    method: 'POST',
    body: { ...request },
    ...(options?.signal ? { signal: options.signal } : {})
  })
}
