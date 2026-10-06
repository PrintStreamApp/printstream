import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizePrinterPath,
  RECURSIVE_SKIP_DIRS,
  resolvePrinterStorageDownloadContentType
} from './printer-storage-policy.js'

test('printer storage paths stay rooted and reject traversal before FTP access', () => {
  assert.equal(normalizePrinterPath(undefined), '/')
  assert.equal(normalizePrinterPath('//models///part.3mf'), '/models/part.3mf')
  assert.throws(() => normalizePrinterPath('/models/../private'), /Invalid path/)
  assert.throws(() => normalizePrinterPath('/models/./part.3mf'), /Invalid path/)
})

test('storage listing skips firmware media folders and downloads retain media types', () => {
  assert.equal(RECURSIVE_SKIP_DIRS.has('timelapse'), true)
  assert.equal(RECURSIVE_SKIP_DIRS.has('models'), false)
  assert.equal(resolvePrinterStorageDownloadContentType('/video.MP4'), 'video/mp4')
  assert.equal(resolvePrinterStorageDownloadContentType('/model.3mf'), 'application/octet-stream')
})
