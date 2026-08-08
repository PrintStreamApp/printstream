/**
 * Types for the generated pin table, so TypeScript consumers can import it.
 * The data stays plain `.mjs` because the generator writes it and the Docker
 * build reads it with bare `node`.
 */
export interface GeneratedEngineAsset {
  url: string
  sha256: string
  bytes: number
}

/** Keyed by engine id, then by platform key (`linux-x64`, `win32-x64`). */
export const ENGINE_ASSETS: Record<string, Record<string, GeneratedEngineAsset | undefined>>
