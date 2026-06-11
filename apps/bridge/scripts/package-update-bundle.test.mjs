import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveUpdateBundleUrl, shouldIncludeUpdateBundleFile } from './package-update-bundle.mjs'

test('resolveUpdateBundleUrl builds same-origin API asset URLs', () => {
  assert.equal(resolveUpdateBundleUrl({
    bundleName: 'bridge-0.2.0.zip',
    apiBaseUrl: 'https://printstream.example.com'
  }), 'https://printstream.example.com/api/bridge-runtime/release-assets/bridge-0.2.0.zip')
})

test('resolveUpdateBundleUrl prefers explicit bundle URLs over generated URLs', () => {
  assert.equal(resolveUpdateBundleUrl({
    bundleName: 'bridge-0.2.0.zip',
    bundleUrl: 'https://cdn.example.com/bridge.zip',
    apiBaseUrl: 'https://printstream.example.com'
  }), 'https://cdn.example.com/bridge.zip')
})

test('shouldIncludeUpdateBundleFile excludes tests and demo runtime files', () => {
  assert.equal(shouldIncludeUpdateBundleFile('dist/index.js'), true)
  assert.equal(shouldIncludeUpdateBundleFile('dist/index.test.js'), false)
  assert.equal(shouldIncludeUpdateBundleFile('dist/demo-index.js'), false)
  assert.equal(shouldIncludeUpdateBundleFile('dist/demo-simulator.d.ts'), false)
})