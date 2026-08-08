/**
 * The billing scope: a customer's licences, payment method, and invoices, one
 * level above their workspaces.
 *
 * Reached from the workspace switcher alongside the platform scope, but it is
 * NOT a workspace context switch — the account is named in the URL and the API
 * scopes on customer membership, so no workspace is selected and none of
 * the workspace-context machinery (headers, cookies, WS scoping) is involved. That
 * keeps a scope with no printers out of code written to assume there are some.
 *
 * The view itself is cloud-only and arrives through a plugin slot, so a public
 * build has no such route and the switcher offers no such entry.
 */
export const BILLING_SCOPE_SLOT = 'billing.scope'

/**
 * What the scope is called, everywhere.
 *
 * Names licensing explicitly: licences live here and nowhere else, and a label
 * reading only "Billing" gives someone looking for their key no reason to open
 * it. One constant so the switcher, the shell chrome, and the page cannot drift
 * apart on it.
 */
export const BILLING_SCOPE_LABEL = 'Billing and licensing'

/** Route pattern for the billing scope, and the builder that must agree with it. */
export const BILLING_SCOPE_ROUTE = '/billing/:customerId'

/**
 * The scope's sections, as routes rather than local tab state.
 *
 * Each is a page in its own right: bookmarkable, reachable from a support reply
 * ("your invoices are at ..."), and survivable across a browser back. Local tab
 * state would give none of that, and this scope is exactly where someone is
 * asked to go and look at one specific thing.
 *
 * `workspaces` is first and is the default, because it is what the account is
 * paying for; `licenses` is second because the scope is named for it and a key
 * is the other reason people open this. The two are the account's two products:
 * a cloud workspace (one plan each) and a self-hosted licence.
 */
export const BILLING_SCOPE_SECTIONS = [
  {
    id: 'workspaces',
    // "Cloud plans", not "Cloud workspaces": this names the same kind of thing
    // as "Self-hosted licenses" next to it — the commercial artifact, not the
    // container it attaches to. A workspace reads as an organisational unit, so
    // a customer hunting for their Pro subscription had no reason to open a tab
    // about workspaces, which is the failure this label exists to prevent.
    //
    // The cost is real and accepted: workspaces are also CREATED and DELETED
    // here, and one does not delete a plan. That mismatch is the lesser one —
    // being unable to find where Pro lives is worse than being mildly surprised
    // that removal sits under plans.
    //
    // The list is deliberately NOT filtered to `kind: cloud`: a workspace taken
    // off the cloud still belongs to the account and still has to be manageable
    // somewhere, so it stays here reading "No cloud plan".
    label: 'Cloud plans',
    // Deliberately parallel to the licences tab below: these are the account's
    // TWO PRODUCTS, and each description says where the thing runs and what is
    // bought. "Keys for running PrintStream on your own machine" / "Workspaces
    // we host for you".
    //
    // It also has to spell out that a workspace IS the unit Pro is sold on.
    // Nothing else on this page says so, and "workspace" reads as an
    // organisational container, not a subscription — so someone looking for
    // "where is my Pro subscription" has no reason to look here.
    description: 'One plan per workspace we host for you. Add, remove, and change them here.'
  },
  {
    id: 'licenses',
    // "Self-hosted licenses", not "Licenses": the neighbouring tab is "Cloud
    // workspaces", and a bare "Licenses" reads as though it covers the cloud
    // plans too. The two tabs are the account's two products and each label
    // has to name which one it is.
    label: 'Self-hosted licenses',
    // Only where the line says something the heading does not. People, Payment
    // method, and Invoices would just restate themselves.
    description: 'Keys for running PrintStream on your own machine, and the builds to run.'
  },
  { id: 'people', label: 'People' },
  {
    id: 'messages',
    label: 'Messages',
    // Account-level threads: a conversation is stamped with the workspace it was
    // started from, and the ones started here belong to no workspace. Billing
    // questions are about the account, so this is where they live.
    description: 'Your conversations with us about this account.'
  },
  // "Payment", not "Payment method": the tab row carries six labels and this
  // was the longest, and the shorter word loses nothing -- the section holds
  // one card that names the method itself.
  { id: 'payment', label: 'Payment' },
  { id: 'invoices', label: 'Invoices' },
  // Last, and small on purpose: the scope had no settings at all, which meant
  // its appearance was decided somewhere the customer could not see or reach.
  //
  // No description, by this list's own rule -- one is written only where it
  // says something the heading does not. Anything describing what is currently
  // IN here ("how this area looks", "on this device") is a summary of today's
  // single card: it presumes theme is the only setting, and goes stale the
  // moment a second one lands. What is genuinely worth saying is scope, and
  // that belongs on the setting it qualifies, where `BillingSettingsPanel`
  // already says it.
  { id: 'settings', label: 'Settings' }
] as const

export type BillingScopeSectionId = (typeof BILLING_SCOPE_SECTIONS)[number]['id']

/** A section as callers consume it; only some carry helper text. */
export type BillingScopeSection = {
  id: BillingScopeSectionId
  label: string
  description?: string
}

export const billingScopeSections: ReadonlyArray<BillingScopeSection> = BILLING_SCOPE_SECTIONS

export const DEFAULT_BILLING_SCOPE_SECTION: BillingScopeSectionId = 'workspaces'

/** Route pattern for a section within the scope. */
export const BILLING_SCOPE_SECTION_ROUTE = `${BILLING_SCOPE_ROUTE}/:section`

/**
 * The section a URL segment names, or the default when it names nothing we
 * serve — a stale bookmark should land on the scope, not on a blank page.
 */
export function parseBillingScopeSection(section: string | undefined): BillingScopeSectionId {
  return BILLING_SCOPE_SECTIONS.some((entry) => entry.id === section)
    ? (section as BillingScopeSectionId)
    : DEFAULT_BILLING_SCOPE_SECTION
}

/**
 * The account and section a billing-scope URL names, or null when the path is
 * not in the scope at all.
 *
 * The account comes from the URL and nowhere else: someone can hold billing on
 * more than one, so "the first account this user has" would quietly point the
 * scope's own navigation at a different customer's money.
 */
export function parseBillingScopePath(pathname: string): {
  customerId: string
  section: BillingScopeSectionId
} | null {
  const match = /^\/billing\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname)
  if (!match?.[1]) return null
  return {
    customerId: decodeURIComponent(match[1]),
    section: parseBillingScopeSection(match[2])
  }
}

export function buildBillingScopePath(customerId: string, section?: BillingScopeSectionId): string {
  const base = `/billing/${encodeURIComponent(customerId)}`
  // The default section stays on the bare path so the switcher entry and a
  // bookmark of the landing tab are the same URL.
  return section && section !== DEFAULT_BILLING_SCOPE_SECTION ? `${base}/${section}` : base
}
