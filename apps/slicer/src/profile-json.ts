import { ensureCliSupportedPresetFrom } from '@printstream/shared'

/**
 * Normalizes a SHIPPED catalogue preset for `--load-settings`.
 *
 * The flattened `*_full` JSONs do not all carry `from`, and the CLI refuses a preset without a
 * supported one. Counterpart: `custom-profile-resolve.ts`, which stamps `User` on user presets.
 */
export function sanitizeBuiltinSlicerProfileJson(content: string): string {
  const parsed = JSON.parse(content) as Record<string, unknown>
  ensureCliSupportedPresetFrom(parsed, 'system')
  return `${JSON.stringify(parsed, null, 2)}\n`
}
