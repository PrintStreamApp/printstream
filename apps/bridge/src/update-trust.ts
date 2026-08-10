/**
 * Trust roots used to verify signed bridge app-bundle updates. The key itself
 * is the release-signing trust root shared with the native server app; it
 * lives in `@printstream/shared` so both verifiers embed one constant.
 */
export { OFFICIAL_UPDATE_PUBLIC_KEY as OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY } from '@printstream/shared'
