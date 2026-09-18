import assert from 'node:assert/strict'
import test from 'node:test'
import { isMarketingPath } from './marketingManifest.js'

test('marketing home and info routes use the same manifest on browser and native hosts', () => {
  const paths = ['/', '/register', '/get-started', '/privacy', '/terms', '/how-it-works']
  for (const path of paths) assert.equal(isMarketingPath(path, paths), true, path)
  assert.equal(isMarketingPath('/workspaces', paths), false)
})

test('the public build without marketing routes keeps root in the app', () => {
  assert.equal(isMarketingPath('/', []), false)
  assert.equal(isMarketingPath('/register', []), false)
})
