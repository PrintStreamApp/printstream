import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSafeOutboundUrl } from './outbound-url-guard.js'

test('accepts a normal https URL and returns the parsed URL', () => {
  const url = assertSafeOutboundUrl('https://ntfy.sh/my-topic')
  assert.equal(url.hostname, 'ntfy.sh')
  assert.equal(url.pathname, '/my-topic')
})

test('rejects non-http(s) schemes', () => {
  assert.throws(() => assertSafeOutboundUrl('file:///etc/passwd'), /must use https/i)
  assert.throws(() => assertSafeOutboundUrl('gopher://example.com'), /must use https/i)
})

test('rejects http unless explicitly allowed', () => {
  assert.throws(() => assertSafeOutboundUrl('http://example.com'), /must use https/i)
  assert.doesNotThrow(() => assertSafeOutboundUrl('http://example.com', { allowHttp: true }))
})

test('blocks loopback, unspecified, link-local and cloud metadata hosts', () => {
  const blocked = [
    'http://127.0.0.1/x',
    'http://127.5.6.7/x',
    'http://localhost/x',
    'http://0.0.0.0/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x',
    'http://[fe80::1]/x',
    'http://[::ffff:127.0.0.1]/x'
  ]
  for (const raw of blocked) {
    assert.throws(() => assertSafeOutboundUrl(raw, { allowHttp: true }), /not allowed/i, `expected ${raw} to be blocked`)
  }
})

test('allows RFC-1918 private LAN hosts so self-hosted services keep working', () => {
  // Intentional: self-hosted deployments reach services on their own LAN.
  assert.doesNotThrow(() => assertSafeOutboundUrl('http://192.168.1.10:8080/topic', { allowHttp: true }))
  assert.doesNotThrow(() => assertSafeOutboundUrl('http://10.0.0.5/topic', { allowHttp: true }))
})

test('allow-list pins the host to a domain or its subdomains', () => {
  const opts = { allowedHosts: ['bblmw.com', 'bambulab.com'] as const }
  assert.doesNotThrow(() => assertSafeOutboundUrl('https://public-cdn.bblmw.com/example.zip', opts))
  assert.doesNotThrow(() => assertSafeOutboundUrl('https://bambulab.com/fw.bin', opts))
  assert.throws(() => assertSafeOutboundUrl('https://evil.com/fw.bin', opts), /allow-list/i)
  // A look-alike suffix must not slip past the subdomain check.
  assert.throws(() => assertSafeOutboundUrl('https://notbblmw.com/fw.bin', opts), /allow-list/i)
  assert.throws(() => assertSafeOutboundUrl('https://bblmw.com.evil.com/fw.bin', opts), /allow-list/i)
})

test('rejects unparseable input', () => {
  assert.throws(() => assertSafeOutboundUrl('not a url'), /invalid url/i)
})
