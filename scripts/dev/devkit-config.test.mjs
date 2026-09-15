/** Regression coverage for checkout-specific development environment values. */
import assert from 'node:assert/strict'
import test from 'node:test'
import devkitConfig from '../../devkit.config.mjs'

const CONFIG_DIR = '/tmp/devkit-test'

test('worktrees use the primary checkout hostname as their shared passkey RP origin', () => {
  const env = devkitConfig.env({
    url: 'http://issue-87.printstream.localhost',
    identity: {
      repoName: 'printstream',
      isPrimary: false,
      slug: 'issue-87'
    },
    ports: { web: 22070, api: 22071 },
    configDir: CONFIG_DIR
  })

  assert.equal(
    env.CLIENT_ORIGIN,
    'http://printstream.localhost,http://issue-87.printstream.localhost'
  )
})

test('the primary checkout keeps its own origin as the sole client origin', () => {
  const env = devkitConfig.env({
    url: 'http://printstream.localhost',
    identity: {
      repoName: 'printstream',
      isPrimary: true,
      slug: 'printstream'
    },
    ports: { web: 22070, api: 22071 },
    configDir: CONFIG_DIR
  })

  assert.equal(env.CLIENT_ORIGIN, 'http://printstream.localhost')
})

test('the host bridge targets this checkout through its derived API port', () => {
  const env = devkitConfig.env({
    url: 'http://issue-87.printstream.localhost',
    identity: {
      repoName: 'printstream',
      isPrimary: false,
      slug: 'issue-87'
    },
    ports: { web: 22070, api: 22071 },
    configDir: CONFIG_DIR
  })

  assert.deepEqual(devkitConfig.ports, ['web', 'api'])
  assert.equal(env.API_PORT, '4000')
  assert.equal(env.BRIDGE_SERVER_URL, 'http://127.0.0.1:22071')
})
