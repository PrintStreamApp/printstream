import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgePlatformArchLabel, compareBridgePlatforms, groupByBridgeOs, resolveBridgePlatformKey } from './bridgePlatform'

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'

test('resolveBridgePlatformKey maps desktop user agents to package keys', () => {
  assert.equal(resolveBridgePlatformKey({ userAgent: WINDOWS_UA }), 'win32-x64')
  assert.equal(resolveBridgePlatformKey({ userAgent: LINUX_UA }), 'linux-x64')
})

test('resolveBridgePlatformKey prefers UA client hints when available', () => {
  assert.equal(resolveBridgePlatformKey({
    userAgent: LINUX_UA,
    uaDataPlatform: 'Linux',
    uaDataArchitecture: 'arm',
    uaDataBitness: '64'
  }), 'linux-arm64')
  assert.equal(resolveBridgePlatformKey({
    userAgent: MAC_UA,
    uaDataPlatform: 'macOS',
    uaDataArchitecture: 'x86',
    uaDataBitness: '64'
  }), 'darwin-x64')
})

test('resolveBridgePlatformKey defaults Macs without hints to Apple Silicon', () => {
  assert.equal(resolveBridgePlatformKey({ userAgent: MAC_UA }), 'darwin-arm64')
})

test('resolveBridgePlatformKey recommends the native build on Windows-on-ARM', () => {
  assert.equal(resolveBridgePlatformKey({
    userAgent: WINDOWS_UA,
    uaDataPlatform: 'Windows',
    uaDataArchitecture: 'arm',
    uaDataBitness: '64'
  }), 'win32-arm64')
})

test('resolveBridgePlatformKey defaults Windows without hints to x64', () => {
  // Windows ARM browsers report an x64 UA; without UA-CH hints the x64
  // package still runs there via emulation.
  assert.equal(resolveBridgePlatformKey({ userAgent: WINDOWS_UA, uaDataPlatform: 'Windows' }), 'win32-x64')
})

test('resolveBridgePlatformKey detects ARM Linux from the user agent', () => {
  assert.equal(resolveBridgePlatformKey({
    userAgent: 'Mozilla/5.0 (X11; Linux aarch64; rv:126.0) Gecko/20100101 Firefox/126.0'
  }), 'linux-arm64')
})

test('resolveBridgePlatformKey returns null for phones, tablets, and unknowns', () => {
  assert.equal(resolveBridgePlatformKey({ userAgent: ANDROID_UA }), null)
  assert.equal(resolveBridgePlatformKey({ userAgent: IPAD_UA }), null)
  assert.equal(resolveBridgePlatformKey({ userAgent: ANDROID_UA, uaDataPlatform: 'Android' }), null)
  assert.equal(resolveBridgePlatformKey({ userAgent: '' }), null)
})

test('compareBridgePlatforms orders by OS (Windows, macOS, Linux) then x64 before ARM64', () => {
  const shuffled = ['linux-arm64', 'darwin-x64', 'win32-arm64', 'linux-x64', 'win32-x64', 'darwin-arm64']
  assert.deepEqual([...shuffled].sort(compareBridgePlatforms), [
    'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'
  ])
})

test('bridgePlatformArchLabel returns just the architecture', () => {
  assert.equal(bridgePlatformArchLabel('win32-x64'), 'x64')
  assert.equal(bridgePlatformArchLabel('darwin-arm64'), 'Apple Silicon')
  assert.equal(bridgePlatformArchLabel('linux-arm64'), 'ARM64')
})

test('groupByBridgeOs returns ordered OS groups with sorted items', () => {
  const items = ['linux-arm64', 'win32-x64', 'darwin-arm64', 'linux-x64'].map((platformKey) => ({ platformKey }))
  const groups = groupByBridgeOs(items, (item) => item.platformKey)
  assert.deepEqual(groups.map((group) => group.osLabel), ['Windows', 'macOS', 'Linux'])
  assert.deepEqual(groups[2]!.items.map((item) => item.platformKey), ['linux-x64', 'linux-arm64'])
})
