import type { SlicingProfileKind } from '@printstream/shared'

export function sanitizeSlicerProfileJson(content: string, kind: SlicingProfileKind): string {
  const parsed = JSON.parse(content) as Record<string, unknown>
  parsed.type = kind
  return `${JSON.stringify(parsed, null, 2)}\n`
}

export function sanitizeBuiltinSlicerProfileJson(content: string): string {
  const parsed = JSON.parse(content) as Record<string, unknown>
  if (typeof parsed.from !== 'string' || parsed.from.length === 0) {
    parsed.from = 'system'
  }
  return `${JSON.stringify(parsed, null, 2)}\n`
}