import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Printer } from '@printstream/shared'
import type { PrinterFsEntry } from '@printstream/bridge-runtime'
import {
  buildTimelapseThumbnailCandidates,
  deleteTimelapseThumbnails,
  isTimelapseVideoPath
} from './timelapse-thumbnails.js'

const printer = { id: 'printer-1', name: 'Test Printer' } as unknown as Printer

function fileEntry(name: string, path?: string): PrinterFsEntry {
  return { name, path, type: 'file', sizeBytes: 1024, modifiedAt: null }
}

test('isTimelapseVideoPath only matches timelapse videos outside the thumbnail directory', () => {
  assert.equal(isTimelapseVideoPath('/timelapse/video_2024.mp4'), true)
  assert.equal(isTimelapseVideoPath('timelapse/video_2024.mp4'), true)
  assert.equal(isTimelapseVideoPath('/timelapse/thumbnail/video_2024.jpg'), false)
  assert.equal(isTimelapseVideoPath('/timelapse/thumbnail/video_2024.mp4'), false)
  assert.equal(isTimelapseVideoPath('/cache/model.3mf'), false)
  assert.equal(isTimelapseVideoPath('/timelapse/video_2024.jpg'), false)
})

test('deleteTimelapseThumbnails removes the matching thumbnail in the separate directory', async () => {
  const listed: string[] = []
  const deleted: string[] = []
  const result = await deleteTimelapseThumbnails(printer, '/timelapse/video_2024.mp4', {
    listDirectory: async (_printer, dir) => {
      listed.push(dir)
      return [
        fileEntry('video_2024.jpg'),
        fileEntry('video_2024.png'),
        fileEntry('other_clip.jpg')
      ]
    },
    deleteFile: async (_printer, filePath) => {
      deleted.push(filePath)
    }
  })

  assert.deepEqual(listed, ['/timelapse/thumbnail'])
  assert.deepEqual(deleted, ['/timelapse/thumbnail/video_2024.jpg', '/timelapse/thumbnail/video_2024.png'])
  assert.deepEqual(result, ['/timelapse/thumbnail/video_2024.jpg', '/timelapse/thumbnail/video_2024.png'])
})

test('deleteTimelapseThumbnails preserves nested timelapse subdirectories and prefers entry paths', async () => {
  const deleted: string[] = []
  const result = await deleteTimelapseThumbnails(printer, '/timelapse/2024/clip.mp4', {
    listDirectory: async (_printer, dir) => {
      assert.equal(dir, '/timelapse/thumbnail/2024')
      return [fileEntry('clip.jpeg', '/timelapse/thumbnail/2024/clip.jpeg')]
    },
    deleteFile: async (_printer, filePath) => {
      deleted.push(filePath)
    }
  })

  assert.deepEqual(deleted, ['/timelapse/thumbnail/2024/clip.jpeg'])
  assert.deepEqual(result, ['/timelapse/thumbnail/2024/clip.jpeg'])
})

test('deleteTimelapseThumbnails is a no-op for non-timelapse files', async () => {
  let listCalls = 0
  const result = await deleteTimelapseThumbnails(printer, '/cache/model.3mf', {
    listDirectory: async () => {
      listCalls += 1
      return []
    },
    deleteFile: async () => undefined
  })

  assert.equal(listCalls, 0)
  assert.deepEqual(result, [])
})

test('deleteTimelapseThumbnails swallows listing failures', async () => {
  const result = await deleteTimelapseThumbnails(printer, '/timelapse/video_2024.mp4', {
    listDirectory: async () => {
      throw new Error('printer offline')
    },
    deleteFile: async () => {
      throw new Error('should not be called')
    }
  })

  assert.deepEqual(result, [])
})

test('deleteTimelapseThumbnails swallows individual delete failures', async () => {
  const deleted: string[] = []
  const result = await deleteTimelapseThumbnails(printer, '/timelapse/video_2024.mp4', {
    listDirectory: async () => [fileEntry('video_2024.jpg'), fileEntry('video_2024.png')],
    deleteFile: async (_printer, filePath) => {
      if (filePath.endsWith('.jpg')) throw new Error('locked')
      deleted.push(filePath)
    }
  })

  assert.deepEqual(deleted, ['/timelapse/thumbnail/video_2024.png'])
  assert.deepEqual(result, ['/timelapse/thumbnail/video_2024.png'])
})

test('buildTimelapseThumbnailCandidates puts the separate thumbnail directory first', () => {
  const candidates = buildTimelapseThumbnailCandidates('/timelapse/video_2024.mp4')
  assert.equal(candidates.jpg[0], '/timelapse/thumbnail/video_2024.jpg')
  assert.equal(candidates.png[0], '/timelapse/thumbnail/video_2024.png')
})
