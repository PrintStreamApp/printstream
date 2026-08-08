/**
 * The billing account as the shell sees it: a scope a user can switch into,
 * alongside their workspaces and the platform scope.
 *
 * CORE rather than private-cloud, because the web shell's workspace switcher is
 * core and has to be able to render the entry. The cloud is what populates it;
 * a public build reports none and the switcher behaves exactly as before.
 *
 * Counterpart: `apps/api/src/private/cloud/customer.ts`.
 */
import { z } from 'zod'

export const customerSummarySchema = z.object({
  id: z.string(),
  /** Display name, seeded from the owner at creation. Not an identity key. */
  name: z.string().min(1).max(200),
  /** True for the user who holds the billing relationship and may grant access to it. */
  isOwner: z.boolean().default(false),
  /**
   * Whether the viewer may take the account's OWNER-ONLY actions: create and
   * delete workspaces, invite and remove people, reactivate a retired account.
   *
   * Not the same question as `isOwner`, which is a fact about who holds the
   * account. A platform operator with the people-manage permission stands in for
   * the owner on every one of those routes (`requireOwnedCustomerId`), because
   * the owner-only rule exists to stop a mere billing MEMBER handing out access
   * and was never meant to lock out support. Gating the buttons on `isOwner`
   * meant an operator could reach the endpoints but was shown a page with the
   * controls missing.
   *
   * Defaults false, the safe direction: it withholds a button rather than
   * offering one that 403s.
   */
  canActAsOwner: z.boolean().default(false),
  /**
   * Whether paid plans are switched on for this DEPLOYMENT (`BILLING_ENFORCEMENT`).
   * A deployment fact rather than an account one, but it rides on the account
   * because the billing scope has no workspace to ask through.
   */
  billingLive: z.boolean().default(false),
  /**
   * Whether the account already has a payment method with the payment provider.
   *
   * False until the first subscription: a card is captured at checkout, and the
   * hosted portal REFUSES to open without one. The payment surface reads this
   * so it explains that rather than offering a button that errors.
   *
   * Defaults false, which is the safe direction -- it withholds a button rather
   * than showing one that cannot work.
   */
  hasPaymentMethod: z.boolean().default(false),
  /**
   * When this account was retired, or null while it is live.
   *
   * Rides the summary because the SHELL needs it: a retired account still
   * appears in the context switcher (its owner can sign in and reach their
   * invoices, which is the point of retiring rather than deleting), so the
   * switcher has to be able to mark it instead of presenting it as normal.
   */
  dormantAt: z.string().datetime().nullable().default(null),
  /** Whether the owner may bring it back themselves, rather than only ask. */
  dormantSelfRestorable: z.boolean().default(false)
})

export type CustomerSummary = z.infer<typeof customerSummarySchema>
