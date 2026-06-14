process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { FirmwareSource } from './firmware-source.js'

afterEach(() => {
  mock.restoreAll()
})

test('FirmwareSource reads download versions from the HTML __NEXT_DATA__ payload', async () => {
  const nextData = JSON.stringify({
    props: {
      pageProps: {
        printerMap: {
          p1: {
            versions: [
              {
                version: '01.10.00.00',
                url: 'https://public-cdn.bblmw.com/upgrade/device/offline/C11/01.10.00.00/example.zip',
                release_notes_en: '# Version 01.10.00.00\n- Security update',
                release_time: '2026-04-13T03:07:41Z'
              },
              {
                version: '01.09.01.00',
                url: 'https://public-cdn.bblmw.com/upgrade/device/offline/C11/01.09.01.00/example.zip',
                release_notes_en: '# Version 01.09.01.00',
                release_time: '2026-01-14T00:00:00Z'
              }
            ]
          }
        }
      }
    }
  })

  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/support/firmware-download/p1')) {
      return new Response(
        `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }
    if (url.includes('wiki.bambulab.com')) {
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const warnings: string[] = []
  const source = new FirmwareSource({
    warn(message) {
      warnings.push(message)
    }
  })

  const versions = await source.listVersions('P1S')

  assert.equal(versions.length, 2)
  assert.equal(versions[0]?.version, '01.10.00.00')
  assert.equal(versions[0]?.downloadUrl, 'https://public-cdn.bblmw.com/upgrade/device/offline/C11/01.10.00.00/example.zip')
  assert.equal(versions[0]?.releaseNotes, '# Version 01.10.00.00\n- Security update')
  assert.equal(versions[0]?.releaseTime, '2026-04-13T03:07:41Z')
  assert.deepEqual(warnings, [])
})

test('FirmwareSource keeps wiki-only latest versions when the download page lags behind', async () => {
  const nextData = JSON.stringify({
    props: {
      pageProps: {
        printerMap: {
          p1: {
            versions: [
              {
                version: '01.09.01.00',
                url: 'https://public-cdn.bblmw.com/upgrade/device/offline/C11/01.09.01.00/example.zip',
                release_notes_en: '# Version 01.09.01.00',
                release_time: '2026-01-14T00:00:00Z'
              }
            ]
          }
        }
      }
    }
  })

  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/support/firmware-download/p1')) {
      return new Response(
        `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }
    if (url.includes('wiki.bambulab.com')) {
      return new Response(
        '<div id="h-01100000-20260330"></div><div id="h-01090100-20260114"></div>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const source = new FirmwareSource({ warn() {} })
  const versions = await source.listVersions('P1S')

  assert.equal(versions[0]?.version, '01.10.00.00')
  assert.equal(versions[0]?.downloadUrl, '')
  assert.equal(versions[0]?.releaseTime, '20260330')
  assert.equal(versions[1]?.version, '01.09.01.00')
  assert.equal(versions[1]?.downloadUrl, 'https://public-cdn.bblmw.com/upgrade/device/offline/C11/01.09.01.00/example.zip')
})