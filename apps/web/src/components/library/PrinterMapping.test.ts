/**
 * The auto-refill badge must not be gated on the remaining figure.
 *
 * `getSlotRemainingState` reported `usesAutoRefill` correctly for a pair of manually-set
 * spools, and the badge still never appeared: it was nested inside the block that renders
 * the remaining estimate, which is null for any spool that is neither RFID-tagged nor
 * tracked. So the one case the user reported, two hand-set spools backing each other up,
 * was exactly the case that could not display it, and auto-refill looked Bambu-only.
 *
 * A pure test cannot catch that (the state was already right), and neither can the type
 * checker. Rendering `SlotOptionLabel` here is not an option either: it is file-local, and
 * this module's tree reaches `@mui/icons-material`, which a node-runner render test cannot
 * mount (see the web development notes). So the guard reads the source.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'PrinterMapping.tsx')

test('the refill badge renders whether or not a remaining figure does', async () => {
  const source = await readFile(SOURCE, 'utf8')
  assert.match(
    source,
    /\{\(remainingDetail \|\| remainingState\.usesAutoRefill\) && \(/,
    'a slot with no readable remaining estimate must still be able to show the badge'
  )
})

test('the remaining figure comes from the shared grade, not a second RFID gate', async () => {
  const source = await readFile(SOURCE, 'utf8')
  // The label used to re-derive "which remaining signal may be believed" (tracked spool,
  // then `trayUuid != null && remainPercent != null`) beside `getSlotRemainingState`, which
  // decides the same thing. Two copies of that precedence is how the printed figure and the
  // red insufficiency highlight came to disagree about the same slot.
  assert.match(source, /remainingState\.remainGrams != null/)
  assert.ok(
    !/tray\.trayUuid != null && tray\.remainPercent != null/.test(source),
    'believability is `knownRemainGrams`\' call, made once'
  )
})
