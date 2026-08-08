/**
 * Types for the bundled-engine list, so TypeScript consumers can import it.
 * The data stays plain `.mjs` because the Docker build reads it with bare
 * `node`; see the header there for the beta/`isDefault` rules.
 */
export interface SlicerTarget {
  id: string
  label: string
  family: string
  version: string
  slicerName: string
  downloadUrl: string
  /** Only ever set on a stable release. */
  isDefault?: boolean
  /** Bambu ships these as GitHub pre-releases; never the default. */
  prerelease?: boolean
}

export const slicerTargets: SlicerTarget[]
