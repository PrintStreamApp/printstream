/**
 * Public license-related URLs shared by the Settings license section and the
 * license banner. These point at the hosted marketing site regardless of where
 * the install runs (self-hosted installs request keys from printstream.app).
 */
export const COMMUNITY_LICENSE_URL = 'https://printstream.app/self-host/community-license'

/**
 * Where a Lifetime holder extends their updates & support year. Only ever shown
 * once a licence's updates window is known to be lapsing or lapsed, a
 * perpetual key keeps the install running regardless, so surfacing this any
 * earlier would read as "your licence is expiring", which it is not.
 */
export const LICENSE_RENEWAL_URL = 'https://printstream.app/self-host/renew'

/** Cloud resolves authorized billing accounts after sign-in; a single account opens its licenses directly. */
export const CLOUD_BILLING_ENTRY_URL = 'https://printstream.app/billing'
