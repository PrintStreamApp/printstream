import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchMakerWorldDesign, fetchMakerWorldDownloadTarget } from './makerworld-client.js'
import type { BambuAccountCredential } from '../../lib/bambu-account-registry.js'

function credential(
  requestMakerWorld: NonNullable<BambuAccountCredential['requestMakerWorld']>
): BambuAccountCredential {
  return {
    accessToken: 'secret-token',
    region: 'global',
    accountLabel: 'user@example.com',
    requestMakerWorld
  }
}

test('MakerWorld design metadata is read through the account relay', async () => {
  const operations: unknown[] = []
  const design = await fetchMakerWorldDesign({
    designId: 42,
    credential: credential(async (operation) => {
      operations.push(operation)
      return {
        status: 200,
        body: { title: 'Widget', defaultInstanceId: 7, instances: [{ id: 7, title: 'Fast' }] }
      }
    })
  })

  assert.deepEqual(operations, [{ operation: 'getMakerWorldDesign', designId: 42 }])
  assert.equal(design.defaultInstanceId, 7)
})

test('MakerWorld download targets are read through the account relay', async () => {
  const target = await fetchMakerWorldDownloadTarget({
    instanceId: 7,
    credential: credential(async () => ({
      status: 200,
      body: { name: 'widget.3mf', url: 'https://makerworld.bblmw.com/file.3mf?at=signed' }
    }))
  })

  assert.equal(target.fileName, 'widget.3mf')
  assert.match(target.downloadUrl, /^https:\/\/makerworld\.bblmw\.com\//)
})

test('a relayed Cloudflare challenge gets actionable MakerWorld guidance', async () => {
  await assert.rejects(
    fetchMakerWorldDesign({
      designId: 42,
      credential: credential(async () => ({
        status: 403,
        body: null,
        bodyText: '<html><title>Just a moment...</title><script src="https://challenges.cloudflare.com/x"></script></html>'
      }))
    }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 502)
      assert.match(error.message, /security challenge/i)
      assert.match(error.message, /download the model manually/i)
      assert.match(error.message, /upload the downloaded file/i)
      return true
    }
  )
})

test('a direct-fallback Cloudflare challenge gets the same actionable guidance', async () => {
  const directCredential: BambuAccountCredential = {
    accessToken: 'secret-token',
    region: 'global',
    accountLabel: 'user@example.com'
  }

  await assert.rejects(
    fetchMakerWorldDesign({
      designId: 42,
      credential: directCredential,
      deps: {
        fetchImpl: async () => new Response(
          '<html><title>Just a moment...</title><script src="https://challenges.cloudflare.com/x"></script></html>',
          { status: 403, headers: { 'content-type': 'text/html' } }
        )
      }
    }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 502)
      assert.match(error.message, /security challenge/i)
      assert.match(error.message, /download the model manually/i)
      assert.match(error.message, /upload the downloaded file/i)
      return true
    }
  )
})
