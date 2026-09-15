import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupportConversation, SupportMessage } from '@printstream/shared'
import { supportConversationAttribution, supportMessageSenderName } from './conversationAttribution.js'

const hostedConversation: SupportConversation = {
  id: 'conversation-1',
  kind: 'question',
  subject: 'A question',
  status: 'open',
  userId: 'user-1',
  userName: 'Pat',
  userEmail: 'pat@example.com',
  workspaceId: 'workspace-1',
  workspaceName: 'Workshop',
  userRoles: ['Owner'],
  assignedToUserId: null,
  assignedToName: null,
  createdAt: '2026-09-13T20:00:00.000Z',
  lastMessageAt: '2026-09-13T20:00:00.000Z',
  lastMessagePreview: 'A question',
  messageCount: 1,
  unreadCount: 1
}

const selfHostedConversation: SupportConversation = {
  ...hostedConversation,
  userName: null,
  userEmail: null,
  workspaceName: 'My Workspace',
  customerId: 'customer-1',
  customerName: 'Platform Admin Account',
  licenseId: 'license-secret-id',
  licenseName: 'Metered Test Install',
  installationFingerprint: 'installation-secret-fingerprint'
}

const userMessage: SupportMessage = {
  id: 'message-1',
  side: 'user',
  senderName: 'Unknown user',
  body: 'A question',
  createdAt: '2026-09-13T20:00:00.000Z',
  attachments: [],
  pageUrl: null,
  appVersion: null,
  userAgent: null
}

test('self-hosted attribution shows only the account holder and license name', () => {
  assert.equal(
    supportConversationAttribution(selfHostedConversation),
    'Platform Admin Account · Metered Test Install'
  )
})

test('hosted attribution keeps the user, role, and workspace context', () => {
  assert.equal(
    supportConversationAttribution(hostedConversation),
    'Pat <pat@example.com> · Owner · Workspace: Workshop'
  )
})

test('self-hosted user messages use the account holder name', () => {
  assert.equal(supportMessageSenderName(selfHostedConversation, userMessage), 'Platform Admin Account')
  assert.equal(
    supportMessageSenderName(selfHostedConversation, { ...userMessage, side: 'platform', senderName: 'Ryan' }),
    'Ryan'
  )
})
