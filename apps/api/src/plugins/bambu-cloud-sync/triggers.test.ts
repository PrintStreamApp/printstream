import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_PLUGIN = path.resolve(HERE, '../../../../web/src/plugins/bambu-cloud-sync')

/**
 * A REGRESSION guard, not a style rule.
 *
 * Nothing polls Bambu for preset changes — by design. That makes the WEB side the only
 * thing that ever asks, and it means a break here is silent: `/status` still answers, the
 * chip still renders `null`, every test still passes, and the feature simply never
 * appears. That shipped once, when the background pass was removed and the chip was left
 * reading `/status` (which only replays a stored check) with nothing left to produce one.
 *
 * So: something in the web plugin must call `/check`.
 */
test('a preset surface actually triggers the check, since nothing else will', async () => {
  const sources = await Promise.all(
    ['BambuCloudSyncStatus.tsx', 'BambuCloudSyncCard.tsx'].map(async (file) => (
      await readFile(path.join(WEB_PLUGIN, file), 'utf8')
    ))
  )

  assert.ok(
    sources.some((source) => source.includes('bambu-cloud-sync/check')),
    'no web surface calls /check — with no background pass, nothing would ever work out '
      + 'whether presets are outstanding, and the indicator would never appear'
  )
})

test('the API still exposes the check route the web side depends on', async () => {
  const source = await readFile(path.join(HERE, 'index.ts'), 'utf8')
  assert.match(source, /router\.post\('\/check'/)
})
