/**
 * Choose the help composer transport without making the core dialog depend on
 * a plugin module. Self-hosted support needs both an active contribution and a
 * currently eligible commercial licence; otherwise email remains available.
 */
export function resolveHelpSupportTransport(
  selfHosted: boolean,
  activeConversationPluginNames: readonly string[],
  selfHostedEligible = true
): { inApp: boolean; base: string } {
  if (!selfHosted) return { inApp: true, base: '/api/support' }
  const connected = selfHostedEligible && activeConversationPluginNames.includes('cloud-connection')
  return {
    inApp: connected,
    base: '/api/plugins/cloud-connection/support'
  }
}
