// IDs are strings; timestamps are ISO 8601 strings.

export type ConversationStatus = 'open' | 'pending' | 'resolved';

export type ConversationHandler = 'automation' | 'human_queue' | 'human_agent';

export type ChannelType = 'widget' | 'product_app' | 'whisppr';

export type MessageSenderType = 'customer' | 'automation' | 'human_agent' | 'system';

export type MessageType = 'text' | 'attachment' | 'system' | 'internal_note';

export type MessageStatus = 'sent' | 'delivered' | 'read';

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

export interface App {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface Customer {
  id: string;
  organizationId: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  appId: string;
  customerId: string;
  channel: ChannelType;
  status: ConversationStatus;
  handler: ConversationHandler;
  assignedAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderType: MessageSenderType;
  // Customer or HumanAgent ID; null for automation and system senders.
  senderId: string | null;
  messageType: MessageType;
  status: MessageStatus;
  content: string | null;
  attachmentUrl: string | null;
  createdAt: string;
}

export interface HumanAgent {
  id: string;
  authUserId: string | null;
  organizationId: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  status: 'online' | 'offline' | 'away';
  createdAt: string;
}
