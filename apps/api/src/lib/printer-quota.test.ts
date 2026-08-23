/**
 * The quota gate's `raiseLimit` seam, which spends money.
 *
 * Every assertion here is about WHEN the raise runs and what it is asked for.
 * Getting either wrong is a billing bug, not a logic bug: raising on an add that
 * was already covered charges for capacity the customer had, and asking for
 * "limit + 1" instead of "the count this add needs" buys capacity that still
 * does not cover the fleet when an install is already over its allowance.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { conflict } from './http-error.js'
import { assertPrinterQuotaOrThrow, registerPrinterQuota, __resetPrinterQuotaForTests } from './printer-quota.js'

afterEach(() => {
  __resetPrinterQuotaForTests()
})

test('an add inside the limit never reaches the raise', async () => {
  let raises = 0
  registerPrinterQuota({
    getLimit: async () => 5,
    countPrinters: async () => 2,
    raiseLimit: async () => { raises += 1; return 99 }
  })
  await assertPrinterQuotaOrThrow('ws_1')
  assert.equal(raises, 0, 'buying capacity for an add that was already covered charges for nothing')
})

test('the raise is asked for the total this add needs, not the limit plus one', async () => {
  // An install can sit ABOVE its limit (a downgraded key, a half-failed raise).
  // There, limit + 1 = 3 would still not cover the 5 printers about to exist.
  const asked: number[] = []
  registerPrinterQuota({
    getLimit: async () => 2,
    countPrinters: async () => 4,
    raiseLimit: async (needed) => { asked.push(needed); return needed }
  })
  await assertPrinterQuotaOrThrow('ws_1')
  assert.deepEqual(asked, [5])
})

test('a raise that still does not cover the add refuses', async () => {
  registerPrinterQuota({
    getLimit: async () => 2,
    countPrinters: async () => 2,
    // Bought one, but the add needs three covered.
    raiseLimit: async () => 3,
    describeLimit: (limit) => `covers ${limit}`
  })
  await assertPrinterQuotaOrThrow('ws_1')

  __resetPrinterQuotaForTests()
  registerPrinterQuota({
    getLimit: async () => 2,
    countPrinters: async () => 5,
    raiseLimit: async () => 3,
    describeLimit: (limit) => `covers ${limit}`
  })
  await assert.rejects(assertPrinterQuotaOrThrow('ws_1'), /covers 3/)
})

test("a refusal reason from the raise reaches the operator instead of the generic cap message", async () => {
  // "Upgrade your plan" in front of a declined card sends them to the wrong
  // place entirely.
  registerPrinterQuota({
    getLimit: async () => 2,
    countPrinters: async () => 2,
    raiseLimit: async () => { throw conflict('Your payment was declined.') },
    describeLimit: () => 'Upgrade your plan to add more.'
  })
  await assert.rejects(assertPrinterQuotaOrThrow('ws_1'), /payment was declined/)
})

test('a surface with no raise still refuses at the limit', async () => {
  // The cloud registers no `raiseLimit`, it meters after the add, so the gate
  // must behave exactly as it did before the seam existed.
  registerPrinterQuota({
    getLimit: async () => 2,
    countPrinters: async () => 2,
    describeLimit: (limit) => `limited to ${limit}`
  })
  await assert.rejects(assertPrinterQuotaOrThrow('ws_1'), /limited to 2/)
})

test('a second registration is refused rather than silently replacing the first', () => {
  // Build-exclusive by design, so a collision is a wiring bug. Letting the
  // second win silently drops whichever cap registered first, on a
  // misconfigured build that is licence enforcement, i.e. the cap vanishes
  // exactly where it is the only thing protecting a paid product.
  registerPrinterQuota({
    getLimit: async () => 1,
    countPrinters: async () => 0
  })
  assert.throws(
    () => registerPrinterQuota({ getLimit: async () => 99, countPrinters: async () => 0 }),
    /only one surface may cap printers/
  )
})
