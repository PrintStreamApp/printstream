/**
 * The slicer-runtime policy for a browser-prepared project.
 *
 * A `browser-prepared-v1` project has already had the user's complete editor and slicing intent
 * authored into its 3MF. The runtime may still perform mechanics the CLI itself requires, but it
 * must not reinterpret the request into another project or load process/filament profiles that
 * override that file. The selected custom machine may ride beside it as a runtime identity and
 * portable-asset carrier when it matches the machine already authored into the project.
 */

export interface PreparedSourceCarrier {
  preparedSource?: {
    contractVersion?: number
  } | null
  preparedProject?: {
    contractVersion?: number
  } | null
}

export interface SlicerInputPolicy {
  /** The uploaded project's settings are the slice's source of truth. */
  projectSettingsAuthoritative: boolean
  /** Load general request profile files on the CLI, which overrides embedded project settings. */
  loadRequestProfiles: boolean
  /** Synthesize/repair an incomplete embedded project config through `--export-settings`. */
  ensureEmbeddedProjectSettings: boolean
  /** Rewrite machine/process/filament identity and colours from request metadata. */
  rewriteRequestMetadata: boolean
}

/**
 * Decide the project-mutation boundary from the explicit prepared-source contract.
 *
 * Unknown contract versions deliberately follow the legacy policy. The shared request schema is
 * expected to reject them before this service receives the request, but failing toward the legacy
 * path here prevents a future version from silently gaining v1's trust semantics.
 */
export function slicerInputPolicy(request: PreparedSourceCarrier): SlicerInputPolicy {
  const preparedV1 = request.preparedSource?.contractVersion === 1
    || request.preparedProject?.contractVersion === 1
  return {
    projectSettingsAuthoritative: preparedV1,
    loadRequestProfiles: !preparedV1,
    ensureEmbeddedProjectSettings: !preparedV1,
    rewriteRequestMetadata: !preparedV1
  }
}
