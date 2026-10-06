import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { env } from './env.js'
import { handleLibraryRpc } from './library-rpc.js'

test('library RPCs validate input and preserve chunk, stat, copy, and delete results', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'printstream-library-rpc-'))
  const previousDir = env.BRIDGE_LIBRARY_DIR
  env.BRIDGE_LIBRARY_DIR = tempDir

  try {
    assert.deepEqual(await handleLibraryRpc('storage.list', {}), { handled: false })
    await assert.rejects(handleLibraryRpc('library.storeStart', { storedPath: '' }))

    assert.deepEqual(await handleLibraryRpc('library.storeStart', { storedPath: 'source.3mf' }), {
      handled: true,
      result: null
    })
    assert.deepEqual(await handleLibraryRpc('library.storeChunk', {
      storedPath: 'source.3mf',
      chunkBase64: Buffer.from('hello').toString('base64')
    }), { handled: true, result: null })

    assert.deepEqual(await handleLibraryRpc('library.readChunk', {
      storedPath: 'source.3mf', offset: 1, maxBytes: 3
    }), {
      handled: true,
      result: { bufferBase64: Buffer.from('ell').toString('base64'), eof: false, sizeBytes: 5 }
    })
    assert.deepEqual(await handleLibraryRpc('library.stat', { storedPath: 'source.3mf' }), {
      handled: true,
      result: { sizeBytes: 5, contentSha256: createHash('sha256').update('hello').digest('hex') }
    })

    assert.deepEqual(await handleLibraryRpc('library.copy', {
      sourceStoredPath: 'source.3mf', targetStoredPath: 'copy.3mf'
    }), { handled: true, result: null })
    assert.deepEqual(await handleLibraryRpc('library.read', { storedPath: 'copy.3mf' }), {
      handled: true,
      result: { bufferBase64: Buffer.from('hello').toString('base64') }
    })
    assert.deepEqual(await handleLibraryRpc('library.delete', { storedPath: 'copy.3mf' }), {
      handled: true,
      result: null
    })
    assert.deepEqual(await handleLibraryRpc('library.read', { storedPath: 'copy.3mf' }), {
      handled: true,
      result: { bufferBase64: null }
    })
  } finally {
    env.BRIDGE_LIBRARY_DIR = previousDir
    await rm(tempDir, { recursive: true, force: true })
  }
})
