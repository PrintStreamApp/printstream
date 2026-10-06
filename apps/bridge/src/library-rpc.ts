/**
 * Validated library-file RPC operations served by the bridge.
 *
 * The runtime owns request ids, socket responses, errors, and cancellation. This module only
 * validates library parameters and performs bridge-local file operations. Library methods do not
 * currently accept an abort signal; the runtime still releases their request tracking on finish.
 */
import {
  bridgeLibraryCopyParamsSchema,
  bridgeLibraryDeleteParamsSchema,
  bridgeLibraryInspect3mfParamsSchema,
  bridgeLibraryInspect3mfResultSchema,
  bridgeLibraryReadChunkParamsSchema,
  bridgeLibraryReadChunkResultSchema,
  bridgeLibraryReadParamsSchema,
  bridgeLibraryReadThumbnailParamsSchema,
  bridgeLibraryReadThumbnailResultSchema,
  bridgeLibraryStatParamsSchema,
  bridgeLibraryStatResultSchema,
  bridgeLibraryStoreChunkParamsSchema,
  bridgeLibraryStoreParamsSchema,
  bridgeLibraryStoreStartParamsSchema
} from '@printstream/shared'
import { THREE_MF_INDEX_PARSER_VERSION } from '@printstream/shared/three-mf'
import {
  appendBridgeLibraryFileChunk,
  copyBridgeLibraryFile,
  deleteBridgeLibraryFile,
  locateBridgeLibraryFile,
  readBridgeLibraryFile,
  readBridgeLibraryFileChunk,
  startBridgeLibraryFileWrite,
  statBridgeLibraryFile,
  writeBridgeLibraryFile
} from './library-storage.js'
import { readBridgeLibraryThreeMfIndex, readBridgeLibraryThumbnail } from './library-3mf.js'

type LibraryRpcResult = { handled: true; result: unknown } | { handled: false }

/** Return a validated result, including null for write operations, or leave another RPC family to the runtime. */
export async function handleLibraryRpc(method: string, params: unknown): Promise<LibraryRpcResult> {
  switch (method) {
    case 'library.store': {
      const parsed = bridgeLibraryStoreParamsSchema.parse(params)
      await writeBridgeLibraryFile(parsed.storedPath, Buffer.from(parsed.fileBase64, 'base64'))
      return { handled: true, result: null }
    }
    case 'library.storeStart': {
      const parsed = bridgeLibraryStoreStartParamsSchema.parse(params)
      await startBridgeLibraryFileWrite(parsed.storedPath)
      return { handled: true, result: null }
    }
    case 'library.storeChunk': {
      const parsed = bridgeLibraryStoreChunkParamsSchema.parse(params)
      await appendBridgeLibraryFileChunk(parsed.storedPath, Buffer.from(parsed.chunkBase64, 'base64'))
      return { handled: true, result: null }
    }
    case 'library.read': {
      const parsed = bridgeLibraryReadParamsSchema.parse(params)
      const buffer = await readBridgeLibraryFile(parsed.storedPath)
      return { handled: true, result: { bufferBase64: buffer ? buffer.toString('base64') : null } }
    }
    case 'library.readChunk': {
      const parsed = bridgeLibraryReadChunkParamsSchema.parse(params)
      const chunk = await readBridgeLibraryFileChunk(parsed.storedPath, parsed.offset, parsed.maxBytes)
      return {
        handled: true,
        result: bridgeLibraryReadChunkResultSchema.parse({
          bufferBase64: chunk ? chunk.buffer.toString('base64') : null,
          eof: chunk?.eof ?? true,
          sizeBytes: chunk?.sizeBytes
        })
      }
    }
    case 'library.inspect3mf': {
      const parsed = bridgeLibraryInspect3mfParamsSchema.parse(params)
      const index = await readBridgeLibraryThreeMfIndex(await locateBridgeLibraryFile(parsed.storedPath))
      // The API re-parses locally when this bridge lags behind its own index parser.
      return {
        handled: true,
        result: bridgeLibraryInspect3mfResultSchema.parse({ index, parserVersion: THREE_MF_INDEX_PARSER_VERSION })
      }
    }
    case 'library.stat': {
      const parsed = bridgeLibraryStatParamsSchema.parse(params)
      const info = await statBridgeLibraryFile(parsed.storedPath)
      return { handled: true, result: bridgeLibraryStatResultSchema.parse(info) }
    }
    case 'library.copy': {
      const parsed = bridgeLibraryCopyParamsSchema.parse(params)
      await copyBridgeLibraryFile(parsed.sourceStoredPath, parsed.targetStoredPath)
      return { handled: true, result: null }
    }
    case 'library.readThumbnail': {
      const parsed = bridgeLibraryReadThumbnailParamsSchema.parse(params)
      const png = await readBridgeLibraryThumbnail(
        await locateBridgeLibraryFile(parsed.storedPath),
        parsed.plateIndex ?? null
      )
      return {
        handled: true,
        result: bridgeLibraryReadThumbnailResultSchema.parse({
          pngBase64: png ? png.toString('base64') : null
        })
      }
    }
    case 'library.delete': {
      const parsed = bridgeLibraryDeleteParamsSchema.parse(params)
      await deleteBridgeLibraryFile(parsed.storedPath)
      return { handled: true, result: null }
    }
    default:
      return { handled: false }
  }
}
