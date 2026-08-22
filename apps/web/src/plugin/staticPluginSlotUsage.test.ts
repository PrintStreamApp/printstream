import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_ROOT = path.join(SRC_ROOT, 'plugins')

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) yield full
  }
}

/**
 * Slots that may stay on `StaticPluginSlot`, each for a stated reason. Anything not
 * listed here must go through `PluginSlot`.
 */
const EXEMPT_SLOTS = new Map<string, string>([
  // The auth plugins are always installed AND always enabled (they back the platform's
  // own sign-in), and most of these surfaces render BEFORE a plugin-manager session
  // exists — which is precisely what StaticPluginSlot was built for. Routing them
  // through the enabled check would gate sign-in on a query that needs sign-in.
  ['auth.signIn', 'auth plugins are always enabled; renders pre-session'],
  ['auth.recentVerification', 'auth plugins are always enabled; renders pre-session'],
  ['auth.userManagement.credentials', 'auth plugins are always enabled'],
  ['auth.userManagement.lifecycle', 'auth plugins are always enabled'],
  ['account.security', 'auth plugins are always enabled'],
  ['settings.authenticationProviders', 'auth plugins are always enabled'],
  ['settings.authenticationSetup', 'auth plugins are always enabled; renders during setup'],
  // Calibration's always-mounted wizard host. It renders nothing on its own — it only
  // shows a wizard its LAUNCH points ask for, and those go through `PluginSlot`, so a
  // disabled calibration plugin has nothing to open it. Inert rather than correct: if
  // this host ever renders on its own it should move to `PluginSlot`.
  ['shell.overlays', 'inert host; its launch points are separately gated']
])

/**
 * A REGRESSION guard, not a style rule.
 *
 * `StaticPluginSlot` renders a slot's contributions WITHOUT consulting plugin state —
 * no enabled check, no runtime-surface check. That is correct for the surfaces it was
 * built for: auth/setup screens that must render before a plugin-manager session
 * exists, and private cloud modules (billing, support, platform) that are not toggleable
 * plugins at all.
 *
 * It is wrong for a slot fed by a toggleable built-in plugin under `src/plugins/`.
 * Using it there renders the plugin's UI in workspaces that turned the plugin off —
 * which shipped once for `slicing.presets.sync`, where the Bambu Cloud panel appeared
 * for workspaces without the plugin and let someone type account credentials into a
 * form the API would only reject at submit (the plugin router answers 503 when
 * disabled, so nothing leaked — it was purely a dead end).
 *
 * Nothing else catches this: both components take the same props and typecheck
 * identically, and the failure only shows up in a workspace with the plugin disabled.
 */
test('a built-in plugin slot is never rendered through StaticPluginSlot', async () => {
  // Slot names contributed by built-in (toggleable) web plugins, read from source
  // rather than imported — importing a plugin entry pulls in Joy and its icons, which
  // the node test runner cannot load.
  const pluginSlotNames = new Map<string, string>()
  for await (const file of walk(PLUGINS_ROOT)) {
    const source = await readFile(file, 'utf8')
    // Matches a `slots: [{ name: 'x', component: Y }]` entry in a WebPlugin definition.
    for (const match of source.matchAll(/\{\s*name:\s*'([^']+)',\s*component:/g)) {
      const slotName = match[1]
      if (slotName) pluginSlotNames.set(slotName, path.relative(SRC_ROOT, file))
    }
  }
  assert.ok(pluginSlotNames.size > 0, 'found no built-in plugin slots — the scan pattern went stale')

  const offenders: string[] = []
  for await (const file of walk(SRC_ROOT)) {
    if (file.endsWith(path.join('plugin', 'StaticPluginSlot.tsx'))) continue
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/<StaticPluginSlot[^>]*?\bname=(?:"([^"]+)"|\{'([^']+)'\})/gs)) {
      const slotName = match[1] ?? match[2]
      if (!slotName || EXEMPT_SLOTS.has(slotName)) continue
      const owner = pluginSlotNames.get(slotName)
      if (owner) {
        offenders.push(`${path.relative(SRC_ROOT, file)} renders "${slotName}" (owned by ${owner})`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These slots belong to toggleable built-in plugins, so they must use `PluginSlot` '
      + '(which checks enabled state and runtime surface) rather than `StaticPluginSlot`'
  )
})
