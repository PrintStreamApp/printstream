import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveImportReadiness } from './importReadiness'

const base = {
  hasUrl: true,
  hasBridge: true,
  strategy: 'unsupported' as const,
  resolutionMessage: 'Unsupported URL.',
  hasSelectedCandidate: false,
  isDirectPrintable: false,
  makerWorld: null,
  requiresManualIntervention: false
}

// The regression this module was extracted for: a MakerWorld model page is importable
// server-side, but the old rule only allowed a direct file URL or a picked candidate,
// so both buttons stayed disabled forever with nothing explaining it.
test('a MakerWorld model imports once the account path is available', () => {
  const readiness = resolveImportReadiness({
    ...base,
    strategy: 'browser-assist',
    makerWorld: { enabled: true, accountConnected: true }
  })
  assert.deepEqual(readiness, { canImport: true, canPrint: true, reason: null })
})

test('a MakerWorld model explains each half of its unavailability', () => {
  assert.match(
    resolveImportReadiness({ ...base, strategy: 'browser-assist', makerWorld: { enabled: false, accountConnected: true } }).reason ?? '',
    /turned off/i
  )
  assert.match(
    resolveImportReadiness({ ...base, strategy: 'browser-assist', makerWorld: { enabled: true, accountConnected: false } }).reason ?? '',
    /connect a bambu lab account/i
  )
})

test('a direct file URL imports, and prints only when already printable', () => {
  assert.deepEqual(
    resolveImportReadiness({ ...base, strategy: 'server-download', isDirectPrintable: true }),
    { canImport: true, canPrint: true, reason: null }
  )
  const mesh = resolveImportReadiness({ ...base, strategy: 'server-download', isDirectPrintable: false })
  assert.equal(mesh.canImport, true)
  assert.equal(mesh.canPrint, false)
  assert.match(mesh.reason ?? '', /needs slicing/i)
})

// The companion helper is unadvertised until it ships on the Chrome Web Store, so a
// blocked provider must state the limitation without pitching something the user has
// no way to obtain.
test('a provider PrintStream cannot fetch says so without pitching the helper', () => {
  const readiness = resolveImportReadiness({ ...base, strategy: 'browser-assist' })
  assert.equal(readiness.canImport, false)
  assert.match(readiness.reason ?? '', /cannot download/i)
  assert.doesNotMatch(readiness.reason ?? '', /extension|helper|install|download it from/i)
})

test('an unsupported URL surfaces the resolution message rather than going silent', () => {
  const readiness = resolveImportReadiness({ ...base, resolutionMessage: 'Paste a full URL.' })
  assert.equal(readiness.canImport, false)
  assert.equal(readiness.reason, 'Paste a full URL.')
})

// Every disabled state must carry a reason EXCEPT the empty form, which explains itself.
test('says nothing before a URL is typed, and always says something after', () => {
  assert.deepEqual(
    resolveImportReadiness({ ...base, hasUrl: false }),
    { canImport: false, canPrint: false, reason: null }
  )

  const afterTyping = [
    { ...base },
    { ...base, strategy: 'browser-assist' as const },
    { ...base, strategy: 'server-download' as const, hasBridge: false },
    { ...base, requiresManualIntervention: true },
    { ...base, makerWorld: { enabled: true, accountConnected: true }, hasBridge: false }
  ]
  for (const input of afterTyping) {
    const readiness = resolveImportReadiness(input)
    assert.equal(readiness.canImport, false)
    assert.ok(readiness.reason, `expected a reason for ${JSON.stringify(input)}`)
  }
})
