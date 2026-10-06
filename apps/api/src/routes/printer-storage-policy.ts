/**
 * Request-boundary policy for printer storage paths and listings.
 *
 * Normalized paths use the printer's POSIX root and reject traversal segments before any FTP
 * operation. The directory skip list is conservative so recursive model browsing does not scan
 * firmware-managed media folders while still visiting unknown user directories.
 */
import path from 'node:path'
import { badRequest } from '../lib/http-error.js'

/**
 * Normalise a user-supplied path to a printer-absolute POSIX path. We
 * disallow `..` segments to keep callers from escaping the FTP root, and
 * collapse double slashes for predictable matching.
 */
export function normalizePrinterPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  const segments = raw.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw badRequest('Invalid path')
  }
  return '/' + segments.join('/')
}

/**
 * Bambu firmware-managed directories that never contain user-printable
 * models. Skipping them keeps the recursive Models listing fast on
 * printers with full SD cards (timelapses, camera dumps, etc.). The
 * list is intentionally conservative: anything not on it is treated
 * as a possible custom folder and will be searched.
 */
export const RECURSIVE_SKIP_DIRS: ReadonlySet<string> = new Set([
  'cam',
  'corelogger',
  'image',
  'upcam',
  'language',
  'logger',
  'recorder',
  'timelapse',
  // Thumbnails generated alongside recorded timelapses; nothing
  // user-actionable lives there.
  'thumbnail'
])

export function resolvePrinterStorageDownloadContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.mp4':
      return 'video/mp4'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.gcode':
    case '.config':
    case '.txt':
    case '.log':
    case '.csv':
    case '.md5':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}
