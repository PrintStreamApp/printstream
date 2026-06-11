import assert from 'node:assert/strict'
import test from 'node:test'
import { invalidatePluginRelatedQueries } from './pluginQueryInvalidation'

test('invalidatePluginRelatedQueries refreshes plugin, auth bootstrap, and plugin settings queries together', async () => {
  const calls: Array<{ queryKey?: unknown[] }> = []

  await invalidatePluginRelatedQueries({
    invalidateQueries: async (input) => {
      calls.push({ queryKey: Array.isArray(input?.queryKey) ? input.queryKey : undefined })
      return undefined
    }
  })

  assert.deepEqual(calls, [
    { queryKey: ['admin-plugins'] },
    { queryKey: ['plugin-catalog'] },
    { queryKey: ['auth-bootstrap'] },
    { queryKey: ['plugin-settings'] }
  ])
})