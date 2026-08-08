import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkOfTheWeb } from './download-origin.js'

const zone = (lines: string[]): string => ['[ZoneTransfer]', 'ZoneId=3', ...lines].join('\r\n')

test('recovers the origin a browser recorded, dropping the asset path', () => {
  const origin = parseMarkOfTheWeb(zone([
    'HostUrl=https://staging.printstream.app/api/bridge-runtime/release-assets/printstream-bridge-abc-windows-x64.exe'
  ]))
  assert.equal(origin, 'https://staging.printstream.app')
})

test('HostUrl wins over ReferrerUrl', () => {
  assert.equal(
    parseMarkOfTheWeb(zone(['ReferrerUrl=https://wrong.example.com/x', 'HostUrl=https://staging.printstream.app/y'])),
    'https://staging.printstream.app'
  )
})

test('a self-hosted LAN server over plain http is honoured', () => {
  assert.equal(parseMarkOfTheWeb(zone(['HostUrl=http://printer.lan:4000/x'])), 'http://printer.lan:4000')
})

test('anything that is not an http(s) URL yields nothing, so the baked default stands', () => {
  // The stream is written by whatever fetched the file, so each of these is a
  // real possibility, and each must fall back rather than be used downstream.
  assert.equal(parseMarkOfTheWeb(zone(['HostUrl=file:///C:/Users/x/bridge.exe'])), null)
  assert.equal(parseMarkOfTheWeb(zone(['HostUrl=about:internet'])), null)
  assert.equal(parseMarkOfTheWeb(zone(['HostUrl=not a url'])), null)
  // The common case for a locally-built or unblocked binary: a mark with no URL.
  assert.equal(parseMarkOfTheWeb(zone([])), null)
  assert.equal(parseMarkOfTheWeb(''), null)
})
