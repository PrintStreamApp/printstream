/** Consistent sync counts and directions for the badge tooltip and preset-manager notice. */
import { formatDateTime } from '../../lib/time'

/** Name the actionable pull/upload count without including deletions awaiting consent. */
export function describeOutstandingLabel(importable: number, uploadable: number): string {
  if (importable > 0 && uploadable > 0) return `${importable + uploadable} preset changes`
  if (importable > 0) return `${importable} preset update${importable === 1 ? '' : 's'}`
  return `${uploadable} preset${uploadable === 1 ? '' : 's'} to upload`
}

/** Explain each sync direction and the last preview time, without suggesting deletion consent. */
export function describeOutstanding(importable: number, uploadable: number, pending: number, checkedAt: string | undefined): string {
  const parts: string[] = []
  if (importable > 0) parts.push(`${importable} to import from Bambu Cloud`)
  if (uploadable > 0) parts.push(`${uploadable} to upload`)
  if (pending > 0) parts.push(`${pending} deletion${pending === 1 ? '' : 's'} awaiting a decision`)
  const checked = checkedAt ? new Date(checkedAt) : null
  const when = !checked || Number.isNaN(checked.getTime()) ? '' : ` Checked ${formatDateTime(checked)}.`
  return `${parts.join(', ')}.${when}`
}
