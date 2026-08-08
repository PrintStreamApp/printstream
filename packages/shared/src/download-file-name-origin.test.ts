/**
 * The filename is the bridge's most durable piece of provenance.
 *
 * Windows' Mark of the Web is deleted by setup before it elevates, so a retry
 * of the same downloaded file has already lost it — and a retry is exactly what
 * follows a failed install. The name survives that, a copy to another machine,
 * and a browser's "(1)" dedupe, so it is read first.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readOriginFromDownloadFileName, stampDownloadFileNameWithOrigin } from './bridges.js'

test('round-trips an origin through a Windows filename', () => {
  const stamped = stampDownloadFileNameWithOrigin(
    'printstream-bridge-a2ddb70e0bed-windows-x64.exe',
    'https://staging.printstream.app'
  )
  // The extension has to stay last, or Windows will not run it.
  assert.ok(stamped.endsWith('.exe'), `expected an .exe, got ${stamped}`)
  assert.equal(readOriginFromDownloadFileName(stamped), 'https://staging.printstream.app')
})

test('round-trips on Linux, where there is no extension', () => {
  const stamped = stampDownloadFileNameWithOrigin(
    'printstream-bridge-a2ddb70e0bed-linux-x64',
    'https://staging.printstream.app'
  )
  assert.equal(readOriginFromDownloadFileName(stamped), 'https://staging.printstream.app')
})

test('keeps the scheme and port of a self-hosted LAN server', () => {
  // Guessing https here would produce a bridge that cannot reach its own server.
  const stamped = stampDownloadFileNameWithOrigin('printstream-bridge-abc-linux-x64', 'http://printer.lan:4000')
  assert.ok(!stamped.includes(':'), 'a colon is illegal in a Windows filename')
  assert.ok(!stamped.includes('/'), 'a slash would make it a path')
  assert.equal(readOriginFromDownloadFileName(stamped), 'http://printer.lan:4000')
})

test('survives a browser re-download suffix', () => {
  const stamped = stampDownloadFileNameWithOrigin('printstream-bridge-abc-windows-x64.exe', 'https://staging.printstream.app')
  const redownloaded = stamped.replace('.exe', ' (1).exe')
  // Downloading twice is ordinary, and falling back to the cloud on the second
  // attempt is the exact failure this mechanism exists to prevent.
  assert.equal(readOriginFromDownloadFileName(redownloaded), 'https://staging.printstream.app')
})

test('an unstamped name yields nothing, so the baked default stands', () => {
  assert.equal(readOriginFromDownloadFileName('printstream-bridge-abc-windows-x64.exe'), null)
  assert.equal(readOriginFromDownloadFileName('printstream-bridge-abc-linux-x64'), null)
  // A hyphen-rich name must not be mistaken for a stamp.
  assert.equal(readOriginFromDownloadFileName('printstream-bridge--windows--x64.exe'), null)
})

test('a stamp that is not an http(s) origin is refused', () => {
  assert.equal(readOriginFromDownloadFileName('bridge--from--file--C_\\evil.exe'), null)
  // A bare word is no longer junk — it is a label under the default host — so a
  // junk token now yields a well-formed origin that simply does not resolve.
  // That is the better failure: a visible connection error beats silently
  // falling back to the cloud, which is the bug this whole stamp exists to stop.
  assert.equal(readOriginFromDownloadFileName('bridge--from--nonsense.exe'), 'https://nonsense.printstream.app')
})

test('https is implied, so the common name carries no scheme', () => {
  // Deliberately NOT one of our subdomains: that form drops the host entirely
  // (see the label test), which would hide whether the scheme was dropped too.
  const stamped = stampDownloadFileNameWithOrigin(
    'printstream-bridge-abc-windows-arm64.exe',
    'https://ps.example.com'
  )
  assert.equal(stamped, 'printstream-bridge-abc-windows-arm64--from--ps.example.com.exe')
  assert.equal(readOriginFromDownloadFileName(stamped), 'https://ps.example.com')
})

test('http is spelled out, because a LAN self-host is not reachable over https', () => {
  const stamped = stampDownloadFileNameWithOrigin('printstream-bridge-abc-linux-x64', 'http://printer.lan:4000')
  assert.ok(stamped.includes('--from--http--'), `expected the scheme kept, got ${stamped}`)
  assert.equal(readOriginFromDownloadFileName(stamped), 'http://printer.lan:4000')
})

test('names stamped before the scheme was implied still decode', () => {
  // Those files are on disks already; a rename must not strand them on the cloud.
  assert.equal(
    readOriginFromDownloadFileName('printstream-bridge-abc-windows-x64--from--https--staging.printstream.app.exe'),
    'https://staging.printstream.app'
  )
})

test('a punycode host is not mistaken for a scheme separator', () => {
  // Every punycode label contains `--`, so the scheme test has to be anchored.
  const stamped = stampDownloadFileNameWithOrigin('bridge-abc-linux-x64', 'https://xn--bcher-kva.example')
  assert.equal(readOriginFromDownloadFileName(stamped), 'https://xn--bcher-kva.example')
})

test('a subdomain of the default host is written as its label alone', () => {
  const stamped = stampDownloadFileNameWithOrigin('printstream-bridge-abc-windows-arm64.exe', 'https://staging.printstream.app')
  assert.equal(stamped, 'printstream-bridge-abc-windows-arm64--from--staging.exe')
  assert.equal(readOriginFromDownloadFileName(stamped), 'https://staging.printstream.app')
})

test("a host that is not ours keeps its full name", () => {
  // The short form means "a subdomain of the default host". Applying it blindly
  // would resolve a self-hoster's printstream.acme.com to acme.printstream.app —
  // a real server, just not theirs.
  for (const origin of ['https://printstream.acme.com', 'https://ps.example.com:8443', 'http://printer.lan:4000']) {
    const stamped = stampDownloadFileNameWithOrigin('bridge-abc-linux-x64', origin)
    assert.equal(readOriginFromDownloadFileName(stamped), origin, `round-trip failed for ${origin}`)
  }
})

test('a deeper subdomain keeps its full host', () => {
  // `a.b` as a token would be indistinguishable from a full host, since a dot is
  // exactly what marks one.
  const stamped = stampDownloadFileNameWithOrigin('bridge-abc-linux-x64', 'https://a.b.printstream.app')
  assert.ok(stamped.endsWith('--from--a.b.printstream.app'), stamped)
  assert.equal(readOriginFromDownloadFileName(stamped), 'https://a.b.printstream.app')
})

test('full-host names stamped before labels existed still decode', () => {
  assert.equal(
    readOriginFromDownloadFileName('printstream-bridge-abc-windows-x64--from--staging.printstream.app.exe'),
    'https://staging.printstream.app'
  )
})
