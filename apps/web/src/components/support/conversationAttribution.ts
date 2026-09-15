/**
 * Public-facing attribution for support conversations.
 *
 * Hosted conversations identify the local user and workspace. A self-hosted
 * install is represented by the account that owns its licence, so local user,
 * workspace, credential, and installation details do not crowd the public
 * identity shown in the inbox or thread.
 */
import type { SupportConversation, SupportMessage } from '@printstream/shared'

/** Describe who is in the conversation without exposing internal identifiers. */
export function supportConversationAttribution(conversation: SupportConversation): string {
  if (conversation.licenseId) {
    return [
      conversation.customerName ?? 'Unknown account',
      conversation.licenseName ?? 'Self-hosted license'
    ].join(' · ')
  }

  const submitter = conversation.userName ?? conversation.userEmail ?? 'Unknown user'
  return [
    conversation.userEmail && conversation.userName
      ? `${submitter} <${conversation.userEmail}>`
      : submitter,
    conversation.userRoles.length > 0 ? conversation.userRoles.join(', ') : null,
    conversation.workspaceName ? `Workspace: ${conversation.workspaceName}` : null
  ].filter((part): part is string => part !== null).join(' · ')
}

/** Attribute self-hosted user messages to the licence-owning account. */
export function supportMessageSenderName(
  conversation: SupportConversation,
  message: SupportMessage
): string {
  if (conversation.licenseId && message.side === 'user') {
    return conversation.customerName ?? 'Unknown account'
  }
  return message.senderName
}
